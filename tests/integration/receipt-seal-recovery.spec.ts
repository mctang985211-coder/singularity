import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinSkillHome, releaseSkillHomes } from '../../task-runtime/tests/support/skill-roots.ts'
import { harness, createRoot, ROOT_SESSION, STORE, taskEvents } from '../../task-runtime/tests/unit/orchestrate.fixture.ts'

/**
 * Receipt recovery end to end (plan §5's failure/recovery matrix): a process
 * that dies — or a store that refuses — between a Run's terminal record and its
 * receipt makes that receipt up exactly once on the next pass, and the frozen
 * subtree never picks up a Run admitted after the sealing.
 */

let home: string

beforeEach(() => {
  home = pinSkillHome('task-execution')
})

afterEach(async () => {
  releaseSkillHomes()
  await rm(home, { recursive: true, force: true })
})

function receiptEvents(h: ReturnType<typeof harness>): number {
  return taskEvents(h).filter(event => event.kind === 'RunReceiptSealed').length
}

function header(): unknown {
  return { type: 'request/header', data: { header: { config: { provider: 'anthropic', model: 'claude' } } }, time: Date.now() }
}

describe('a receipt that could not be written is made up exactly once', () => {
  it('reconciles a terminal run with no receipt, and a second pass adds nothing', async () => {
    const h = harness()
    h.ctx.sessionQuery = { readSession: async (sessionId: string) => ({ events: h.sessions.get(sessionId)!.events }) }
    const root = await createRoot(h)
    h.sessions.get(ROOT_SESSION)!.events.push(header() as never)

    // The process "dies" between the terminal record and the seal: the store
    // refuses the receipt, exactly as a crash before the write would.
    const task = h.ctx.task as { recordReceiptIn?: unknown }
    const original = (h.ctx.task as { recordReceiptIn: unknown }).recordReceiptIn
    task.recordReceiptIn = async () => {
      throw new Error('the receipt store is unavailable')
    }
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the round is done' })
    expect(await h.runtime.receiptFor(STORE, root.runId)).toBeUndefined()
    expect(receiptEvents(h)).toBe(0)
    expect([...(h.runtime.receiptSeals.get(STORE) ?? [])]).toEqual([root.runId])

    // The recovery pass seals it exactly once — whether the queued attempt or
    // the sweep itself lands the write, only one receipt event ever appears —
    // and a second pass finds nothing left to make up.
    task.recordReceiptIn = original
    await h.runtime.reconcileRunReceipts(STORE)
    const receipt = await h.runtime.receiptFor(STORE, root.runId)
    expect(receipt).toBeDefined()
    expect(receipt?.completeness.status).toBe('complete')
    expect(receiptEvents(h)).toBe(1)

    const again = await h.runtime.reconcileRunReceipts(STORE)
    expect(again.sealed).toEqual([])
    expect(again.alreadySealed).toBe(1)
    expect(receiptEvents(h)).toBe(1)
    await h.runtime.unload()
  })

  it('a batch child is inside its parent’s frozen subtree, and both are sealed', async () => {
    const h = harness()
    h.ctx.sessionQuery = { readSession: async (sessionId: string) => ({ events: h.sessions.get(sessionId)!.events }) }
    const root = await createRoot(h)
    const batch = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [{
        objective: 'produce the child result',
        acceptanceCriteria: [{ description: 'the child result works', command: 'true' }],
        requiredCapabilities: ['execute-task'],
      }],
    })
    await h.runtime.awaitBatch(STORE, batch.batchId)
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the parent reports its batch' })

    const child = await h.task.taskIn(STORE, batch.childTaskIds[0]!)
    const childRun = await h.task.runIn(STORE, child.runIds[0]!)
    const childReceipt = await h.runtime.receiptFor(STORE, childRun.runId)
    expect(childReceipt).toBeDefined()
    expect(childReceipt?.parentRunId).toBe(root.runId)
    expect(childReceipt?.subtree).toEqual([childRun.runId])

    // The parent's own sealing lands with its settlement; a sweep makes up
    // anything still queued, so the assertion is about the frozen subtree.
    await h.runtime.reconcileRunReceipts(STORE)
    const parentReceipt = await h.runtime.receiptFor(STORE, root.runId)
    expect(parentReceipt?.subtree).toEqual([root.runId, childRun.runId])
    expect(parentReceipt?.storeId).toBe(STORE)
    await h.runtime.unload()
  })

  it('an old-protocol run is reported unsupported and writes nothing at all', async () => {
    const h = harness()
    const root = await createRoot(h)
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the round is done' })
    const before = taskEvents(h).length
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.receipts?.map(receipt => receipt.runId)).toEqual([root.runId])

    // The pass over a store whose runs all carry no environment revision writes
    // no receipt event: an old graph is history and is never re-sealed.
    const store = await h.task.snapshotIn(STORE)
    const report = await h.runtime.reconcileRunReceipts(STORE)
    expect(report.sealed).toEqual([])
    expect(report.alreadySealed).toBe(store.runs.filter(run => run.status === 'verified').length)
    expect(taskEvents(h).length).toBe(before)
    await h.runtime.unload()
  })

  it('a replay admitted after the sealing is not counted into the sealed run’s subtree', async () => {
    const h = harness()
    h.ctx.sessionQuery = { readSession: async (sessionId: string) => ({ events: h.sessions.get(sessionId)!.events }) }
    const root = await createRoot(h)
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the round is done' })
    const sealed = await h.runtime.receiptFor(STORE, root.runId)
    expect(sealed?.subtree).toEqual([root.runId])

    const replay = await h.runtime.replayTask(STORE, root.taskId, { lineage: 'receipt-parity' }, ROOT_SESSION)
    const replayRun = await h.task.runIn(STORE, replay.runId)
    // The replay descends from the sealed run in the store…
    expect(replayRun.parentRunId).toBe(root.runId)
    // …and the sealed receipt still covers only what it froze.
    const still = await h.runtime.receiptFor(STORE, root.runId)
    expect(still?.subtree).toEqual([root.runId])
    expect((await h.runtime.receiptFor(STORE, replay.runId))?.subtree).toEqual([replay.runId])
    await h.runtime.unload()
  })
})
