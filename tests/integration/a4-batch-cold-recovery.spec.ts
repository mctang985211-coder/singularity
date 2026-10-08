import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { RunId } from '../../task/src/index.ts'
import { workspace, Boot, ROOT, children, STORE } from './a4-question-cold-recovery.fixture.ts'

/**
 * K1 §5's two crash windows, over this fixture's real sessions and its real store
 * — the batch end is a fact about the store, and both windows are about the two
 * sides of it:
 *
 * - **window one** — every child is terminal and the process dies *before* the
 *   handback is durable. The restart drives the same batch to its end: the children
 *   that are already terminal are adopted (never started again), and the parent is
 *   handed back its execution and told the batch is over, once;
 * - **window two** — the handback is durable (`waiting_children → active`) and the
 *   process dies *before* the parent is told. The restart finds the same Run in the
 *   state the first process left it — a delegated parent, not an abandoned worker —
 *   brings the same Session back, and re-states the message under the identity the
 *   batch derives, which the target's own fold answers at most once;
 * - the same window inside a **replay tree**, where the parent that has to come
 *   back is a resumed worker rather than the store's own root.
 */
describe('the batch end across the restart (K1 §5)', () => {
  it('window one: ends the batch the crash interrupted before the handback, once, and hands the parent back', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    // The parent's own drain inside the batch end is the step before the phase
    // change (children drained, then the parent, then `waiting_children → active`):
    // freezing it lands the crash with every child terminal and nothing handed back.
    const first = await Boot.open(dir, {
      parkDrain: (sessionId, index) => sessionId === ROOT && index === 2,
      script: (_sessionId, index) =>
        index === 0
          ? [
              { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
              { text: "root: the batch is the runtime's now" },
            ]
          : [
              { waitFor: () => childGo.promise },
              { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
              { text: 'child: submitted' },
            ],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = first.spawns[0] as string
    const childRun = (await first.runOf(childSession)).runId
    const rootRun = (await first.runOf(ROOT)).runId
    const batchId = (await first.runOf(ROOT)).batchId
    if (batchId === undefined) throw new Error('the root opened no batch')
    childGo.resolve()
    await vi.waitFor(
      async () => {
        const snapshot = await first.snapshot()
        expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
        // The children are all terminal and the handback is frozen: the run still
        // waits on its batch, and nobody was told anything.
        expect(snapshot.runs.find(run => run.runId === rootRun)?.executionPhase).toBe('waiting_children')
      },
      { timeout: 30_000 },
    )
    expect(first.copiesOf(ROOT, `m-batchend-${batchId}`)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: () => [{ text: 'root: recovered, nothing to add' }],
    })
    await second.root()
    await second.adopt()

    const after = await vi.waitFor(
      async () => {
        const snapshot = await second.snapshot()
        expect(snapshot.runs.find(run => run.runId === rootRun)?.executionPhase).toBe('active')
        return snapshot
      },
      { timeout: 30_000 },
    )
    // One batch, one execution: the child that was already terminal was adopted, not
    // started again — no second spawn, no second run, one verdict.
    expect(second.spawns).toEqual([])
    const childTaskId = after.runs.find(run => run.runId === childRun)?.taskId
    expect(after.runs.filter(run => run.taskId === childTaskId)).toHaveLength(1)
    expect(after.runs.find(run => run.runId === childRun)?.status).toBe('verified')
    expect(after.reviews.filter(review => review.runId === childRun)).toHaveLength(1)
    // The parent got its own decision back: the same Run, active, the batch as
    // history and no current batch, and no verdict of its own.
    const parent = after.runs.find(run => run.runId === rootRun)!
    expect(parent.status).toBe('running')
    expect(parent.batchId).toBeUndefined()
    expect(parent.batches?.map(batch => batch.batchId)).toEqual([batchId])
    expect(after.reviews.some(review => review.runId === rootRun)).toBe(false)
    // …and it was told exactly once, under the identity the batch derives. The
    // phase is durable before the delivery is made (the handback, then the wake),
    // so the message is awaited the way the second window awaits its redelivery.
    await vi.waitFor(() => expect(second.copiesOf(ROOT, `m-batchend-${batchId}`)).toBe(1), { timeout: 20_000 })
    expect(after.runs).toHaveLength(2)
    await second.dispose()
  }, 90_000)

  it('window two: delivers the end-of-batch result the crash interrupted before its Session was told', async () => {
    const dir = workspace()
    const delivered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = await Boot.open(dir, {
      // The handback is durable the moment this latch is reached — the run is
      // `active` again — and the delivery that would tell the parent never returns:
      // the crash point K1 §5 names. `release` is never resolved; the boot is dead.
      gateDelivery: intent =>
        intent.messageId.startsWith('m-batchend-') ? (delivered.resolve(), release.promise) : undefined,
      script: (_sessionId, index) =>
        index === 0
          ? [
              { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
              { text: "root: the batch is the runtime's now" },
            ]
          : [{ tool: 'task_submit_result', args: { summary: 'child work delivered' } }, { text: 'child: submitted' }],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = first.spawns[0] as string
    const childRun = (await first.runOf(childSession)).runId
    const rootRun = (await first.runOf(ROOT)).runId
    await delivered.promise
    // The batch is read from the run's own accumulation: the handback already
    // happened (it is why the delivery is being made), so the run holds it as
    // history rather than as its current batch.
    const batchId = (await first.runOf(ROOT)).batches?.[0]?.batchId
    if (batchId === undefined) throw new Error('the root admitted no batch')
    const crashed = await first.snapshot()
    const crashedParent = crashed.runs.find(run => run.runId === rootRun)!
    expect(crashedParent.status).toBe('running')
    expect(crashedParent.executionPhase).toBe('active')
    expect(crashedParent.batchId).toBeUndefined()
    expect(crashed.runs.find(run => run.runId === childRun)?.status).toBe('verified')
    // The message never landed: the parent's own log holds no copy of it.
    expect(first.copiesOf(ROOT, `m-batchend-${batchId}`)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: () => [{ text: 'root: recovered' }],
    })
    await second.root()
    await second.adopt()

    const after = await second.snapshot()
    // The same Run, the same Session, the same batch: nothing was re-run and no
    // verdict was invented for the parent.
    const parent = after.runs.find(run => run.runId === rootRun)!
    expect(parent.status).toBe('running')
    expect(parent.executionPhase).toBe('active')
    expect(parent.batches?.map(batch => batch.batchId)).toEqual([batchId])
    expect(after.runs).toHaveLength(2)
    expect(second.spawns).toEqual([])
    expect(after.reviews.some(review => review.runId === rootRun)).toBe(false)
    // The recovery pass re-derived the message and stated it once: the identity is
    // the batch's own, and the copy is in the parent's Session log.
    await vi.waitFor(() => expect(second.copiesOf(ROOT, `m-batchend-${batchId}`)).toBe(1), { timeout: 20_000 })
    await vi.waitFor(
      () => expect(second.adapter.textsOf(ROOT).some(text => text.includes(`[task-batch-end ${batchId}]`))).toBe(true),
      { timeout: 20_000 },
    )
    // A second pass over the same store adds nothing: the fold decides, not a ledger.
    await second.runtime.reconcileStore(STORE)
    expect(second.copiesOf(ROOT, `m-batchend-${batchId}`)).toBe(1)
    expect(second.spawns).toEqual([])
    await second.dispose()
  }, 90_000)

  it('window two in a replay tree: brings the replay parent back and tells it its batch ended, once', async () => {
    const dir = workspace()
    const delivered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let replaySession = ''
    let replayRun: RunId = '' as RunId
    let replayBatchId: string | undefined

    const first = await Boot.open(dir, {
      gateDelivery: intent =>
        intent.messageId.startsWith('m-batchend-') ? (delivered.resolve(), release.promise) : undefined,
      script: (_sessionId, index) => {
        if (index === 0) return [{ text: "root: the replay is the runtime's" }]
        // The replay's own worker: it decomposes for real, which makes the replay
        // session a waiting parent with a batch of its own.
        if (index === 1) {
          return [
            {
              tool: 'task_decompose',
              args: { reason: 'split the replayed work', children: children('replay child work') },
            },
            { text: "replay: the batch is the runtime's now" },
          ]
        }
        return [
          { tool: 'task_submit_result', args: { summary: 'replay child work delivered' } },
          { text: 'child: submitted' },
        ]
      },
    })
    await first.begin()
    const champion = await first.writeChampion()
    const replaying = first.runtime.replayTask(STORE, champion, { lineage: 'evolution-replay:p1' }, ROOT)
    replaying.catch(() => undefined)
    await vi.waitFor(() => expect(first.spawns.length).toBeGreaterThanOrEqual(2), { timeout: 20_000 })
    replaySession = first.spawns[0] as string
    replayRun = (await first.runOf(replaySession)).runId
    const childSession = first.spawns[1] as string
    const childRun = (await first.runOf(childSession)).runId
    await delivered.promise
    // The batch is read from the run's own accumulation: the handback already
    // happened (it is why the delivery is being made), so the run holds it as
    // history rather than as its current batch.
    replayBatchId = (await first.runOf(replaySession)).batches?.[0]?.batchId
    if (replayBatchId === undefined) throw new Error('the replay admitted no batch')
    const crashed = await first.snapshot()
    const crashedParent = crashed.runs.find(run => run.runId === replayRun)!
    expect(crashedParent.executionPhase).toBe('active')
    expect(crashedParent.status).toBe('running')
    expect(crashed.runs.find(run => run.runId === childRun)?.status).toBe('verified')
    // Nothing was told: the delivery was held before the real relay ran, so the
    // message never reached the replay Session's own log.
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId =>
        sessionId === ROOT
          ? [{ text: 'root: nothing but the replayed tree' }]
          : [{ text: 'replay: my batch ended, I carry on' }],
    })
    await second.root()
    await second.adopt()

    // The replay parent is not the store's root: it is a delegated parent whose
    // batches ended, so the pass brings the *same* Session back under its own
    // identity — the branch that used to cancel every unsubmitted worker.
    expect(second.ctx.agents.get(SessionId(replaySession)), 'the replay parent is live again').toBeDefined()
    const after = await second.snapshot()
    const parent = after.runs.find(run => run.runId === replayRun)!
    expect(parent.taskId).toBe(crashedParent.taskId)
    expect(parent.status).toBe('running')
    expect(parent.executionPhase).toBe('active')
    expect(parent.batches?.map(batch => batch.batchId)).toEqual([replayBatchId])
    expect(after.runs.filter(run => run.runId === replayRun)).toHaveLength(1)
    expect(second.spawns).toEqual([])
    expect(after.reviews.some(review => review.runId === replayRun)).toBe(false)
    // Told once, under the batch's own identity, and the replayed tree's own
    // experiment identity is untouched by the delivery.
    await vi.waitFor(() => expect(second.copiesOf(replaySession, `m-batchend-${replayBatchId}`)).toBe(1), {
      timeout: 20_000,
    })
    await vi.waitFor(
      () =>
        expect(
          second.adapter.textsOf(replaySession).some(text => text.includes(`[task-batch-end ${replayBatchId}]`)),
        ).toBe(true),
      { timeout: 20_000 },
    )
    const replayTask = after.tasks.find(task => task.taskId === parent.taskId)
    expect(replayTask?.objective).toContain('[evolution-replay:p1]')
    // What the resumed parent is *not* is an abandoned worker: nothing cancelled
    // it and no verdict was made for it. A second pass over the same store has
    // nothing left to resume — the run is this process's own live work now — which
    // is the same rule a spawned worker lives under (the pass that brought it back
    // was the adoption's, and its report is the adoption's own).
    const report = await second.runtime.reconcileStore(STORE)
    expect(report.questionResumes).toEqual([])
    expect((await second.snapshot()).runs.find(run => run.runId === replayRun)?.status).toBe('running')
    expect(second.copiesOf(replaySession, `m-batchend-${replayBatchId}`)).toBe(1)
    await second.dispose()
  }, 90_000)
})
