import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootTaskStoreId } from '../../../task/src/index.ts'
import { sha256Hex } from '../../../task/src/contract.ts'
import { requestedSession } from '../support/person-request.ts'
import type { OrchestrateEnv } from '../../src/orchestration/types.ts'
import { WorkspaceBusyError, WorkspaceRegistry } from '../../src/index.ts'
import type { WorkspaceOwner } from '../../src/workspace.ts'
import { driveBatch } from '../../src/orchestration/batch.ts'
import { owedBatchResults } from '../../src/orchestration/observe.ts'
import {
  harness,
  createRoot,
  STORE,
  ROOT_SESSION,
  childSpec,
  submitParentResult,
  taskEvents,
  decomposeAndSettle,
  rootContract,
  type Harness,
} from './orchestrate.fixture.ts'

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

/**
 * The owner record the marker for one checkout names, read off disk — what a
 * *stranger* to this process reads before it claims the workspace (§3.4), as
 * opposed to the registry's in-memory stack. `undefined` when no marker is there.
 */
async function markerOwner(bindingRoot: string, workspace: string): Promise<WorkspaceOwner | undefined> {
  try {
    const raw = await readFile(join(bindingRoot, 'workspace-owners', `${sha256Hex(workspace)}.json`), 'utf8')
    return (JSON.parse(raw) as { owner?: WorkspaceOwner }).owner
  } catch {
    return undefined
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
    const proposal = await h.runtime.proposalIn(STORE, (await h.task.runIn(STORE, runId)).batches![0]!.proposalId)
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

    const { batchId } = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      {
        reason: 'split the work',
        children: [childSpec('task a')],
      },
      { signal: controller.signal },
    )
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

  test('an idle worker is reminded once and remains running until explicitly cancelled', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(async () => {})
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('stuck child')],
    })
    await vi.waitFor(() => expect(h.notifications.some(item => item.text.includes('went idle'))).toBe(true))
    const childRun = (await h.task.snapshotIn(STORE)).runs.find(run => run.taskId !== taskId)!
    expect(childRun.status).toBe('running')
    expect(h.cancelled).not.toContain(childRun.sessionId)
    expect(h.notifications.filter(item => item.sessionId === childRun.sessionId)).toHaveLength(1)
    await h.runtime.cancelGraph(STORE, 'explicit stop')
    expect((await h.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['cancelled'])
  })
  test('an explicit submission settles the run, a second one is answered from the record, and a waiting parent refuses to submit', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const replies: Array<{ status: string; detail: string }> = []
    h.setIdleBehavior(async sessionId => {
      replies.push(
        await h.runtime.submitResult(sessionId, { summary: 'implemented and checked', evidenceRefs: ['docs/r.md'] }),
      )
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
    expect(childRun.submission).toMatchObject({
      summary: 'implemented and checked',
      evidenceRefs: ['docs/r.md'],
      origin: 'worker',
    })
    const phaseEvents = taskEvents(h).filter(
      item => item.kind === 'RunPhaseChanged' && item.runId === childRun.runId && item.payload.phase === 'submitted',
    )
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
    expect(parentPhaseEvents.every(item => item.kind !== 'RunPhaseChanged' || item.payload.batchId === batchId)).toBe(
      true,
    )

    // The parent may now submit, and its acceptance is its own: the same entry
    // the worker used, judged by the verifier the deployment wires.
    const settled = await h.runtime.submitResult(ROOT_SESSION, {
      summary: 'the parent combines what the batch delivered',
    })
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

    await expect(h.runtime.submitResult(ROOT_SESSION, { summary: 'parent claims done' })).rejects.toThrow(
      /waiting on its child batch/,
    )
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
    runtime.orchestrateEnv = async () => {
      throw new Error('the checkout cannot be resolved')
    }

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

  test("an idle checkpoint can be followed by a nested batch and the worker's own submission", async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.depth === 2) {
        await h.runtime.submitResult(sessionId, { summary: 'the grandchild is done' })
      }
    })

    const outer = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('splittable child', { decomposable: true })],
    })
    await vi.waitFor(() =>
      expect(h.notifications.some(item => item.text.includes('went idle without submitting'))).toBe(true),
    )
    const middle = await h.runtime.runForSession(h.spawned[0]!.sessionId)
    expect(middle.run.status).toBe('running')
    const nested = await decomposeAndSettle(h, STORE, middle.task.taskId, middle.run.runId, middle.run.sessionId, {
      reason: 'the next stage is independent',
      children: [childSpec('grandchild')],
    })
    expect(nested.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await h.task.runIn(STORE, middle.run.runId)).status).toBe('running')
    await h.runtime.submitResult(middle.run.sessionId, { summary: 'combined the staged result' })
    const outcomes = await h.runtime.awaitBatch(STORE, outer.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(taskEvents(h).filter(item => item.kind === 'RunProgressMarked')).toHaveLength(0)
  })

  test("the batch end opens the gate again: writing, delegating and submitting are the parent's own decisions", async () => {
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

  test("a batch end never answers the parent's own question: active, and its writes stay refused", async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const state: { middleBatchId?: string; middleSession?: string } = {}
    let asked!: () => void
    const askedInStore = new Promise<void>(resolve => {
      asked = resolve
    })
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
        await h.task.askParentQuestionIn(
          STORE,
          {
            childRunId: bound.run.runId,
            requestKey: 'k-middle',
            questionDigest: sha256Hex('the middle worker cannot continue without an answer'),
            questionRef: { sessionId, seq: 1 },
            messageId: 'm-middle-question',
            blocking: true,
          },
          sessionId,
        )
        asked()
        return
      }
      // The grandchild finishes only once its parent has asked: the batch end
      // under test is the one that happens with the question already open.
      await askedInStore
      await h.runtime.submitResult(sessionId, { summary: 'the grandchild is done' })
    })

    const rootBatchId = (
      await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('middle child', { decomposable: true })],
      })
    ).batchId
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
    expect(
      snapshot
        .questions!.all.filter(question => question.childRunId === middleRun.runId)
        .map(question => question.answers ?? []),
    ).toEqual([[]])
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
    await expect(h.runtime.redeliverBatchResult(STORE, 'b-not-a-batch')).rejects.toThrow(/is not recorded in store/)
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
    expect(owed).toEqual([
      {
        taskId,
        runId,
        batchId,
        sessionId: ROOT_SESSION,
        memberTaskIds: [expect.any(String)],
      },
    ])

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

  test("stops a waiting parent whose batch the run's accumulation does not hold, by name", async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    // The old state, written through the store's own service: the run waits on the
    // batch id the pre-K1 build derived from the task, with no consumption and no
    // members — which the store's own reducer accepts (the field's shape is all it
    // checks) and which this build must stop rather than guess an owner for.
    const oldBatchId = `b-${taskId}`
    await h.task.changeRunPhaseIn(STORE, taskId, runId, ROOT_SESSION, {
      phase: 'waiting_children',
      batchId: oldBatchId,
    })
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
    const release = new Promise<void>(resolve => {
      releaseChild = resolve
    })
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
    expect(record.localizedCause).toContain("write convergence of the batch's children could not be confirmed")
    // Nothing was delivered as a batch result either: there is no result to hand
    // back while the checkout is unconfirmed.
    expect(h.relayed.some(item => item.messageId === `m-batchend-${batchId}`)).toBe(false)
  })

  test('an unconfirmed child stop keeps the batch layer on the checkout and reports no handback', async () => {
    const checkoutRoot = checkout('a3-batch-unconfirmed-hold')
    const bindingRoot = join(checkoutRoot, 'bindings')
    const h = harness({ config: { runBindingRoot: bindingRoot, writeDrainTimeoutMs: 20, maxActiveWorkers: 1 } })
    h.ctx.envBuilder = { store: { get: () => ({ path: checkoutRoot }) } }
    const registry = (h.runtime as unknown as { workspaces: WorkspaceRegistry }).workspaces
    const workspace = await realpath(checkoutRoot)
    const { taskId, runId } = await createRoot(h)

    // A jobs service that can never confirm the child's managed work, armed for that
    // one session and only once the store holds the child `verified`: the child's
    // own submission drain has been confirmed by then, so the *batch end's* drain
    // of that same session is the first one that can meet the job.
    let armedSession: string | undefined
    h.ctx.jobs = {
      list: (agent: unknown) =>
        armedSession !== undefined && (agent as { id?: string } | undefined)?.id === armedSession
          ? [{ id: 'job-child', status: 'running' }]
          : [],
      kill: () => {},
      wait: async () => ({ status: 'running' }),
    }
    const realSnapshot = h.task.snapshotIn.bind(h.task)
    vi.spyOn(h.task, 'snapshotIn').mockImplementation(async (storeId: string) => {
      const snapshot = await realSnapshot(storeId)
      const settled = snapshot.runs.find(run => run.taskId !== taskId && run.status === 'verified')
      if (settled !== undefined) armedSession = settled.sessionId
      return snapshot
    })

    const { batchId, childTaskIds } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batchId)
    // The child's own settlement stands — its submission's drain was confirmed —
    // and what the batch end could not confirm is the stop it owes for that child.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await h.task.snapshotIn(STORE)).runs.find(run => run.taskId === childTaskIds[0])!.status).toBe('verified')

    // The checkout was never handed back: the batch's layer is still on top of the
    // stack — in this process's registry *and* in the marker a stranger reads —
    // while the parent is failed with the child's convergence named (§2).
    expect(registry.ownerOf(checkoutRoot)).toMatchObject({ kind: 'batch', storeId: STORE, taskId, batchId })
    await vi.waitFor(async () =>
      expect(await markerOwner(bindingRoot, workspace)).toMatchObject({
        kind: 'batch',
        storeId: STORE,
        taskId,
        batchId,
      }),
    )
    const parentRun = await h.task.runIn(STORE, runId)
    expect(parentRun.status).toBe('failed')
    expect(parentRun.executionPhase).toBe('waiting_children')
    expect(parentRun.batchId).toBe(batchId)
    expect(h.runtime.gate.phaseOf(ROOT_SESSION)).not.toBe('active')
    expect(h.runtime.gate.decide(ROOT_SESSION, 'write').allow).toBe(false)
    const record = (await h.task.snapshotIn(STORE)).reviews.find(review => review.runId === runId)!
    expect(record.outcome).toBe('failed')
    expect(record.localizedCause).toContain("write convergence of the batch's children could not be confirmed")
    // No batch result was delivered either: there is no handback to report while
    // the children's stop is unconfirmed.
    expect(h.relayed.some(item => item.messageId === `m-batchend-${batchId}`)).toBe(false)
  })

  test('confirmed child stops hand the checkout back and open the gate', async () => {
    const checkoutRoot = checkout('a3-batch-handback')
    const bindingRoot = join(checkoutRoot, 'bindings')
    const h = harness({ config: { runBindingRoot: bindingRoot, writeDrainTimeoutMs: 20 } })
    h.ctx.envBuilder = { store: { get: () => ({ path: checkoutRoot }) } }
    const registry = (h.runtime as unknown as { workspaces: WorkspaceRegistry }).workspaces
    const workspace = await realpath(checkoutRoot)
    const { taskId, runId } = await createRoot(h)

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // Every child's stop was confirmed, so the batch handed the checkout back: the
    // parent run's own layer is on top of the stack again (§3.4) — in the registry
    // and in the marker a stranger reads — its phase is the batch's gift, and the
    // gate lets it write (§3.3).
    expect(registry.ownerOf(checkoutRoot)).toMatchObject({ kind: 'run', storeId: STORE, taskId, runId })
    await vi.waitFor(async () =>
      expect(await markerOwner(bindingRoot, workspace)).toMatchObject({ kind: 'run', storeId: STORE, taskId, runId }),
    )
    const parentRun = await h.task.runIn(STORE, runId)
    expect(parentRun.status).toBe('running')
    expect(parentRun.executionPhase).toBe('active')
    expect(parentRun.batchId).toBeUndefined()
    expect(h.runtime.gate.phaseOf(ROOT_SESSION)).toBe('active')
    expect(h.runtime.gate.decide(ROOT_SESSION, 'write').allow).toBe(true)
    // …and it was told, once, under the batch's own message identity.
    expect(h.relayed.filter(item => item.messageId === `m-batchend-${batchId}`)).toHaveLength(1)
    // The parent's own submission is what settles it (K1 §2), and a terminal run
    // releases the layer it held: nothing is left on the checkout.
    expect(await submitParentResult(h)).toBe('verified')
    await vi.waitFor(() => expect(registry.ownerOf(checkoutRoot)).toBeUndefined())
    await vi.waitFor(async () => expect(await markerOwner(bindingRoot, workspace)).toBeUndefined())
    expect(await ownershipMarkers(bindingRoot)).toHaveLength(0)
  })

  test('a cancelled batch still ends closed: the parent is cancelled and its checkout released', async () => {
    const checkoutRoot = checkout('a3-batch-cancel-release')
    const bindingRoot = join(checkoutRoot, 'bindings')
    const h = harness({ config: { runBindingRoot: bindingRoot, writeDrainTimeoutMs: 20 } })
    h.ctx.envBuilder = { store: { get: () => ({ path: checkoutRoot }) } }
    const registry = (h.runtime as unknown as { workspaces: WorkspaceRegistry }).workspaces
    const workspace = await realpath(checkoutRoot)
    // The child never stops — one managed job the drain can never confirm — and the
    // cancellation still ends closed: a stopped batch is a budget stop, not a
    // verdict, and its terminal cleanup releases what it always released. Only the
    // *unconfirmed batch end* withholds the handback (K1 §2).
    let armedSession: string | undefined
    h.ctx.jobs = {
      list: (agent: unknown) =>
        armedSession !== undefined && (agent as { id?: string } | undefined)?.id === armedSession
          ? [{ id: 'job-child', status: 'running' }]
          : [],
      kill: () => {},
      wait: async () => ({ status: 'running' }),
    }
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    armedSession = h.spawned[0]!.sessionId

    const outcomes = await h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    expect((await h.task.runIn(STORE, runId)).status).toBe('cancelled')
    expect((await h.task.snapshotIn(STORE)).runs.every(run => run.status === 'cancelled')).toBe(true)
    // The whole stack came off — the child's layer, the batch's, and the terminal
    // run's own — so a terminal run leaves no claim on the checkout behind it: the
    // registry holds nothing and the marker a stranger would read is gone.
    await vi.waitFor(() => expect(registry.ownerOf(checkoutRoot)).toBeUndefined())
    await vi.waitFor(async () => expect(await markerOwner(bindingRoot, workspace)).toBeUndefined())
    expect(await ownershipMarkers(bindingRoot)).toHaveLength(0)
  })

  test('the root budget refuses a batch whole, refuses a start past maxRuns, and is not reset by reopening the store', async () => {
    const h = harness({ config: { rootBudget: { maxRuns: 2 } } })
    const { taskId, runId } = await createRoot(h)

    // One recorded run (the root) plus two children would need three slots.
    await expect(
      decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('task a'), childSpec('task b')],
      }),
    ).rejects.toThrow(/would need 2 run slot/)

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
    await expect(
      reopened.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('task a'), childSpec('task b')],
      }),
    ).rejects.toThrow(/would need 2 run slot/)

    // A *different* batch is refused by name while that proposal is in flight
    // (K1 §1: one proposal per run at a time), with nothing recorded; withdrawing
    // it frees the run.
    const pendingOfRun = (await h.task.snapshotIn(STORE)).proposals!.all.filter(
      proposal => proposal.kind !== 'root' && proposal.identity.parentRunId === runId,
    )
    expect(pendingOfRun.map(proposal => proposal.status)).toEqual(['ready'])
    const leftover = pendingOfRun[0]!
    await expect(
      h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
        reason: 'a different split',
        children: [childSpec('task a')],
      }),
    ).rejects.toThrow(/decomposition refused: an open decomposition proposal must be continued or cancelled/)
    expect(
      (await h.task.snapshotIn(STORE)).proposals!.all.filter(
        proposal => proposal.kind !== 'root' && proposal.identity.parentRunId === runId,
      ),
    ).toHaveLength(1)
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
    // are recorded, so a third batch has no slot left. The refusal is whole and
    // carries no side effect; and because the count is a store fact, a process
    // that reopens the store counts exactly the same.
    const before = await h.task.snapshotIn(STORE)
    await expect(
      decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
        reason: 'the third round',
        children: [childSpec('task c')],
      }),
    ).rejects.toThrow(/decomposition refused: root run budget is exhausted/)
    const reopened = harness({ config: { rootBudget: { maxRuns: 3 } } }, h.sessions)
    await reopened.task.openStore(STORE)
    await expect(
      reopened.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
        reason: 'the third round',
        children: [childSpec('task c')],
      }),
    ).rejects.toThrow(/decomposition refused: root run budget is exhausted/)
    const after = await h.task.snapshotIn(STORE)
    expect(after.runs).toHaveLength(3)
    expect(after.tasks.map(task => task.taskId).sort()).toEqual(before.tasks.map(task => task.taskId).sort())
    expect(h.spawned).toHaveLength(2)
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
    await expect(
      other.runtime.intakeRootContract(rootTaskStoreId('other-root'), 'other-root', rootContract('second tree')),
    ).rejects.toThrow(WorkspaceBusyError)
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
  async function nestedBatch(
    h: Harness,
  ): Promise<{ rootTaskId: string; rootRunId: string; rootBatchId: string; childSession: string }> {
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
    expect(snapshot.reviews.find(review => review.taskId === neverStarted.taskId)?.anomalies.join(' ')).toContain(
      'cancelled by the caller before this child started',
    )

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

  test('unload is not held up by a driver parked on a nested wait', async () => {
    const h = harness()
    await nestedBatch(h)

    // The unload path aborts every driver it owns; a driver parked on a child
    // that waits on its own batch must wake with the abort (A3 §3.6: the unload
    // waits for a bounded settlement, not for the tree to finish on its own).
    const unloading = (h.disposers[h.disposers.length - 1] as () => Promise<void>)()
    const bounded = await Promise.race([
      unloading.then(() => 'settled'),
      new Promise<string>(resolve => {
        setTimeout(() => resolve('hung'), 2_000).unref()
      }),
    ])
    expect(bounded).toBe('settled')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.runs.every(run => run.status !== 'running')).toBe(true)
  })

  test('a verifier runs while the run\u2019s own store holds the workspace, and the verifier layer is on top', async () => {
    const checkoutRoot = checkout('a3-verifier-exclusive')
    const bindingRoot = join(checkoutRoot, 'bindings')
    // One writer at a time: each child's run holds the checkout in turn, so the
    // verifier's exclusive layer has a holder's layer to sit on.
    const h = harness({ config: { runBindingRoot: bindingRoot, maxActiveWorkers: 1 } })
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
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { taskId: rootTaskId } = await createRoot(h)
    // A terminal champion to replay: a verified task with its own run.
    const championTaskId = 't-champion'
    const championRunId = 'r-champion'
    await h.task.createTaskIn(
      STORE,
      {
        taskId: championTaskId,
        definitionRef: { taskType: 'root', version: 1 },
        objective: 'champion work',
        depth: 0,
        acceptanceCriteria: [
          {
            criterionId: 'ac1-1',
            description: 'it holds',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
            command: 'true',
          },
        ],
        requestedCapabilities: ['research'],
        decompositionStatus: 'leaf',
        status: 'created',
        runIds: [],
        childTaskIds: [],
      },
      'tester',
    )
    await h.task.admitTaskIn(STORE, championTaskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(
      STORE,
      {
        runId: championRunId,
        taskId: championTaskId,
        sessionId: 's-champion',
        capabilitySnapshot: [],
        executionPhase: 'active',
        artifacts: [],
        verifierResults: [],
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      'tester',
    )
    await h.task.markRunStatusIn(STORE, championTaskId, championRunId, 'verifying', 'tester')
    await h.task.recordEvidenceIn(
      STORE,
      {
        evidenceId: `e-${championRunId}`,
        taskRunId: championRunId,
        taskId: championTaskId,
        artifacts: [],
        verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
        claims: [],
        generatedAt: new Date().toISOString(),
      },
      'tester',
    )
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

  test('recovery: a plain active worker resumes its same Run and Session before its batch continues', async () => {
    // One worker at a time: the batch is one child in flight, then the next, which
    // is what "resumes its same Run before its batch continues" describes.
    const h = harness({ config: { maxActiveWorkers: 1 } })
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
    expect(crashed.status).toBe('running')
    expect(restarted.resumed).toEqual([crashedSession])
    expect(
      restarted.notifications.filter(
        item => item.sessionId === crashedSession && item.text.includes('continue this same Run'),
      ),
    ).toHaveLength(1)
    await restarted.runtime.submitResult(crashedSession, { summary: 'continued from persisted history' })
    // The batch resumed: the second child ran (once), and the parent settled.
    await vi.waitFor(() => expect(restarted.spawned).toHaveLength(1))
    expect(restarted.spawned[0]!.sessionId).not.toBe(crashedSession)
    const settled = await restarted.runtime.awaitBatch(STORE, batchId)
    expect(settled.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    // The resumed batch ended the same way a first-run batch does: the parent is
    // active again with the batch's result delivered to it.
    const resumed = await restarted.task.runIn(STORE, runId)
    expect(resumed.status).toBe('running')
    expect(resumed.executionPhase).toBe('active')
    expect(restarted.relayed.find(item => item.messageId === `m-batchend-${batchId}`)?.text).toContain(
      'task_submit_result',
    )
    expect(
      (await restarted.runtime.submitResult(ROOT_SESSION, { summary: 'the parent reports what the batch delivered' }))
        .status,
    ).toBe('verified')
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
      // decision its own batch handed back, before the driver could read
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

    // The process dies, and the restart drives the parent's batch again — one
    // worker at a time, exactly as the batch was driving it before the restart.
    const restarted = harness({ config: { maxActiveWorkers: 1 } }, h.sessions)
    await restarted.task.openStore(STORE)
    await restarted.runtime.reconcileStore(STORE)

    // The child is handed back its own execution *and awaited*: the pass re-derives
    // the message its batch owes it (the relay is asked for exactly that identity),
    // and the parent's driver waits for the run instead of cancelling it — the
    // "in flight when the batch resumed" diagnostic the old branch wrote must not
    // appear.
    const driverWait = restarted.runtime.awaitBatch(STORE, batchId)
    const relay = (
      restarted.ctx as unknown as { agentRuntime: { ensureAgentMessageDelivered: ReturnType<typeof vi.fn> } }
    ).agentRuntime.ensureAgentMessageDelivered
    await vi.waitFor(() =>
      expect(relay).toHaveBeenCalledWith(expect.objectContaining({ messageId: `m-batchend-${childBatchId}` })),
    )
    const held = await restarted.task.snapshotIn(STORE)
    const child = held.runs.find(run => run.runId === childRunId)!
    expect(child.status).toBe('running')
    expect(child.batchId).toBeUndefined()
    expect(held.reviews.some(review => review.runId === childRunId)).toBe(false)
    expect((await restarted.task.runIn(STORE, runId)).executionPhase).toBe('waiting_children')

    // The wait ends the way every other worker wait does — by the batch being
    // cancelled — and the child's own cancellation is that one, not a recovery
    // branch's: the message names the batch, never "was in flight when batch".
    // The handle names this batch's own member either way (never another
    // batch's), while what the child *became* is read from the store, which the
    // cancellation settles: a driver the abort reaches before it ever waits for
    // the child reports that child from a status the cancellation has not
    // written yet.
    await restarted.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)
    expect((await driverWait).map(outcome => outcome.taskId)).toEqual([child.taskId])
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
    await h.task.createTaskIn(
      STORE,
      {
        taskId: submittedTaskId,
        definitionRef: { taskType: 'subtask', version: 1 },
        parentTaskId: taskId,
        objective: 'submitted work',
        depth: 1,
        acceptanceCriteria: [
          {
            criterionId: 'ac1-1',
            description: 'it holds',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
            command: 'true',
          },
        ],
        requestedCapabilities: ['execute-task'],
        decompositionStatus: 'leaf',
        status: 'created',
        runIds: [],
        childTaskIds: [],
      },
      'tester',
    )
    await h.task.admitTaskIn(STORE, submittedTaskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(
      STORE,
      {
        runId: submittedRunId,
        taskId: submittedTaskId,
        sessionId: 's-submitted',
        capabilitySnapshot: [],
        executionPhase: 'active',
        artifacts: [],
        verifierResults: [],
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      'tester',
    )
    await h.task.changeRunPhaseIn(STORE, submittedTaskId, submittedRunId, 'tester', {
      phase: 'submitted',
      submission: {
        summary: 'handed in before the crash',
        evidenceRefs: [],
        submittedAt: new Date().toISOString(),
        origin: 'worker',
      },
    })

    // (b) An old record with no phase at all: the read side derives
    // needs-recovery from that, and nothing here may invent a phase for it.
    const phaselessTaskId = 't-phaseless'
    const phaselessRunId = 'r-phaseless'
    await h.task.createTaskIn(
      STORE,
      {
        taskId: phaselessTaskId,
        definitionRef: { taskType: 'subtask', version: 1 },
        parentTaskId: taskId,
        objective: 'old record',
        depth: 1,
        acceptanceCriteria: [
          {
            criterionId: 'ac1-1',
            description: 'it holds',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
            command: 'true',
          },
        ],
        requestedCapabilities: ['execute-task'],
        decompositionStatus: 'leaf',
        status: 'created',
        runIds: [],
        childTaskIds: [],
      },
      'tester',
    )
    await h.task.admitTaskIn(STORE, phaselessTaskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(
      STORE,
      {
        runId: phaselessRunId,
        taskId: phaselessTaskId,
        sessionId: 's-phaseless',
        capabilitySnapshot: [],
        artifacts: [],
        verifierResults: [],
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      'tester',
    )

    await expect(h.runtime.reconcileStore(STORE)).rejects.toThrow('no capability manifest')
  })
  /**
   * A run a previous process left in flight, written through the store service —
   * the recovery path's subject, in a store this process is also driving.
   */
  async function deadWorkerRun(
    h: Harness,
    parentTaskId: string,
    label: string,
  ): Promise<{ taskId: string; runId: string }> {
    const taskId = `t-${label}`
    const runId = `r-${label}`
    await h.task.createTaskIn(
      STORE,
      {
        taskId,
        definitionRef: { taskType: 'subtask', version: 1 },
        parentTaskId,
        objective: label,
        depth: 1,
        acceptanceCriteria: [
          {
            criterionId: 'ac1-1',
            description: 'it holds',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
            command: 'true',
          },
        ],
        requestedCapabilities: ['execute-task'],
        decompositionStatus: 'leaf',
        status: 'created',
        runIds: [],
        childTaskIds: [],
      },
      'tester',
    )
    await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(
      STORE,
      {
        runId,
        taskId,
        sessionId: `s-${label}`,
        capabilitySnapshot: [],
        artifacts: [],
        verifierResults: [],
        status: 'running',
        executionPhase: 'active',
        startedAt: new Date().toISOString(),
      },
      'tester',
    )
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
    h.task.snapshotIn = async () => {
      attempts += 1
      throw new Error('the log is unreadable')
    }
    // `reconcileStore` now answers with the proposals it could not finish
    // (T2/T3 §5), the question deliveries it owes and the question-waiting
    // workers it tried to bring back (A4 §F.1 — empty here, since the store could
    // not even be read), so "nothing was reconciled" is the empty report — and the
    // read is still attempted exactly once, before anything at all is touched.
    await expect(h.runtime.reconcileStore(STORE)).rejects.toThrow('the log is unreadable')
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
    await expect(h.runtime.reconcileStore(STORE)).rejects.toThrow('no capability manifest')
  })
  test('recovery settles a dead process\u2019s run even while this process drives a replay of the same store', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { taskId, runId } = await createRoot(h)
    // A verified champion to replay: the replay's worker never returns, so its
    // driver is in flight for the whole case.
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.taskId !== taskId) await new Promise<void>(() => {})
    })
    const championTaskId = 't-champion'
    const championRunId = 'r-champion'
    await h.task.createTaskIn(
      STORE,
      {
        taskId: championTaskId,
        definitionRef: { taskType: 'subtask', version: 1 },
        parentTaskId: taskId,
        objective: 'champion work',
        depth: 1,
        acceptanceCriteria: [
          {
            criterionId: 'ac1-1',
            description: 'it holds',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
            command: 'true',
          },
        ],
        requestedCapabilities: ['execute-task'],
        decompositionStatus: 'leaf',
        status: 'created',
        runIds: [],
        childTaskIds: [],
      },
      'tester',
    )
    await h.task.admitTaskIn(STORE, championTaskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(
      STORE,
      {
        runId: championRunId,
        taskId: championTaskId,
        sessionId: 's-champion',
        capabilitySnapshot: [],
        artifacts: [],
        verifierResults: [],
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      'tester',
    )
    await h.task.markRunStatusIn(STORE, championTaskId, championRunId, 'verifying', 'tester')
    await h.task.recordEvidenceIn(
      STORE,
      {
        evidenceId: `e-${championRunId}`,
        taskRunId: championRunId,
        taskId: championTaskId,
        artifacts: [],
        verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
        claims: [],
        generatedAt: new Date().toISOString(),
      },
      'tester',
    )
    await h.task.markRunStatusIn(STORE, championTaskId, championRunId, 'verified', 'tester')

    const replaying = h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p1' }, ROOT_SESSION)
    replaying.catch(() => {})
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const replayRun = await h.runtime.runForSession(h.spawned[0]!.sessionId)
    const dead = await deadWorkerRun(h, taskId, 'dead-worker')

    await expect(h.runtime.reconcileStore(STORE)).rejects.toThrow('no capability manifest')
  })
  test("an unreadable batch snapshot is reported without handing back the parent's child history", async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const first = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the survey',
      children: [childSpec('survey the release')],
    })
    const firstOutcomes = await h.runtime.awaitBatch(STORE, first.batchId)
    const firstMember = firstOutcomes[0]!.taskId
    const second = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the implementation',
      children: [childSpec('implement the release')],
    })
    const realSnapshotIn = h.task.snapshotIn.bind(h.task)
    const secondMember = (await realSnapshotIn(STORE)).tasks.find(
      task => task.parentTaskId === taskId && task.taskId !== firstMember,
    )!.taskId

    // When durable state cannot be read, neither the driver nor its failure
    // cleanup can discover the batch's members honestly. Report that failure;
    // a previous batch's children must never stand in for the missing read.
    let unreadable = true
    vi.spyOn(h.task, 'snapshotIn').mockImplementation(async (storeId: string) => {
      if (unreadable) throw new Error(`store "${storeId}": snapshot could not be read`)
      return await realSnapshotIn(storeId)
    })
    await expect(h.runtime.awaitBatch(STORE, second.batchId)).rejects.toThrow(/could not be read/)
    expect(h.relayed.filter(item => item.messageId === `m-batchend-${second.batchId}`)).toEqual([])
    expect((await realSnapshotIn(STORE)).runs.find(run => run.runId === runId)?.status).toBe('running')

    // Once the store is readable, the normal runtime failure path settles only
    // this batch and records the reason. No inaccessible fact was invented.
    unreadable = false
    await h.runtime.failBatch(STORE, second.batchId, 'the batch snapshot could not be read')
    await vi.waitFor(async () => {
      const after = await realSnapshotIn(STORE)
      expect(after.runs.find(run => run.runId === runId)?.status).toBe('failed')
      expect(after.tasks.find(task => task.taskId === secondMember)?.status).toBe('blocked')
      expect(after.reviews.find(review => review.taskId === secondMember)?.outcome).toBe('blocked')
    })
    const after = await realSnapshotIn(STORE)
    expect(after.tasks.find(task => task.taskId === firstMember)?.status).toBe('verified')
    expect(after.runs.find(run => run.runId === runId)?.batches?.map(batch => batch.batchId)).toEqual([
      first.batchId,
      second.batchId,
    ])
    expect(h.relayed.filter(item => item.messageId === `m-batchend-${second.batchId}`)).toEqual([])
    vi.restoreAllMocks()
  })

  test("a batch driver failure is recorded for the batch's own members, never for the parent's child history", async () => {
    // One child in flight at a time, so the failed read meets the driver's own
    // round rather than a concurrent sibling's.
    const h = harness({ config: { maxActiveWorkers: 1 } })
    const { taskId, runId } = await createRoot(h)

    // Batch one: its member settles `verified`, and the batch end hands the run back
    // `active` — the state a second batch is admitted from (K1 §1).
    const first = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the survey',
      children: [childSpec('survey the release')],
    })
    const firstOutcomes = await h.runtime.awaitBatch(STORE, first.batchId)
    expect(firstOutcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const firstMember = firstOutcomes[0]!.taskId

    const second = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the implementation',
      children: [childSpec('implement the release')],
    })
    const secondMember = (await h.task.snapshotIn(STORE)).tasks.find(
      task => task.parentTaskId === taskId && task.taskId !== firstMember,
    )!.taskId

    // One failed durable read stops the driver. It is injected the moment a read
    // sees this batch's child settled, so it is the driver's own next round that
    // meets it — and later reads succeed, allowing failure settlement to name this
    // batch's members from their own record.
    let readState: 'idle' | 'armed' | 'spent' = 'idle'
    const realSnapshotIn = h.task.snapshotIn.bind(h.task)
    vi.spyOn(h.task, 'snapshotIn').mockImplementation(async (storeId: string) => {
      const snapshot = await realSnapshotIn(storeId)
      if (readState === 'armed') {
        readState = 'spent'
        throw new Error(`store "${storeId}": snapshot could not be read`)
      }
      if (readState === 'idle' && snapshot.runs.some(run => run.taskId !== taskId && run.status === 'verified')) readState = 'armed'
      return snapshot
    })

    const outcomes = await h.runtime.awaitBatch(STORE, second.batchId)
    // The batch's own member, and nothing of the batch before it: the parent task's
    // children are both batches', and this answer is one batch's.
    expect(outcomes.map(outcome => outcome.taskId)).toEqual([secondMember])
    expect(outcomes.map(outcome => outcome.taskId)).not.toContain(firstMember)

    // The failure is the store's own record: the parent run is failed with the
    // driver's cause, and the record it owes names *this* batch's member — never the
    // previous batch's.
    const parentRun = await h.task.runIn(STORE, runId)
    expect(parentRun.status).toBe('failed')
    const record = (await h.task.snapshotIn(STORE)).reviews.find(review => review.runId === runId)!
    expect(record.outcome).toBe('failed')
    expect(record.localizedCause).toContain('the batch driver failed')
    expect(record.localizedCause).toContain('could not be read')
    expect(record.relatedTaskIds).toEqual([secondMember])
    expect(record.relatedTaskIds).not.toContain(firstMember)
    // The first batch's facts are untouched by the second batch's failure, and the
    // run's accumulation still holds both batches.
    expect((await h.task.taskIn(STORE, firstMember)).status).toBe('verified')
    expect(parentRun.batches?.map(batch => batch.batchId)).toEqual([first.batchId, second.batchId])
    vi.restoreAllMocks()
  })

  test('two batches on one run: each batch consumes its own members and nothing of the other', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const first = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the survey',
      children: [childSpec('survey the release')],
    })
    const firstOutcomes = await h.runtime.awaitBatch(STORE, first.batchId)
    const second = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the implementation',
      children: [childSpec('implement the release')],
    })
    const secondOutcomes = await h.runtime.awaitBatch(STORE, second.batchId)

    const firstMember = firstOutcomes[0]!.taskId
    const secondMember = secondOutcomes[0]!.taskId
    expect(secondMember).not.toBe(firstMember)
    expect(firstOutcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(secondOutcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The second batch's end is reported and delivered for its own member: the
    // parent task's children are both batches', and the report is one batch's.
    const message = h.relayed.find(item => item.messageId === `m-batchend-${second.batchId}`)?.text ?? ''
    expect(message).toContain(secondMember)
    expect(message).not.toContain(firstMember)
    // The run accumulated both, and each end handed it back `active` with the batch
    // it closed on the record.
    const run = await h.task.runIn(STORE, runId)
    expect(run.batches?.map(batch => batch.batchId)).toEqual([first.batchId, second.batchId])
    expect(run.executionPhase).toBe('active')
    expect(run.batchId).toBeUndefined()
  })

  test("a batch the parent run's record does not hold is refused by name at the driver", async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    // The state the store's own reducer accepts and this build stops by name (K1 §5):
    // a run that waits on a batch id its accumulation does not hold — a pre-K1
    // `b-<taskId>` — so nothing in the store names that batch's members.
    const oldBatchId = `b-${taskId}`
    await h.task.changeRunPhaseIn(STORE, taskId, runId, ROOT_SESSION, {
      phase: 'waiting_children',
      batchId: oldBatchId,
    })

    const env = await (
      h.runtime as unknown as {
        orchestrateEnv(sessionId: string, actor: string): Promise<OrchestrateEnv>
      }
    ).orchestrateEnv(ROOT_SESSION, 'k1-test')
    const controller = new AbortController()
    const driving = driveBatch(env, {
      storeId: STORE,
      parentTaskId: taskId,
      parentRunId: runId,
      batchId: oldBatchId,
      callerSessionId: ROOT_SESSION,
      reason: 'the batch the store does not record',
      signal: controller.signal,
    })
    // The batch's members are not invented — not another batch's, not the task's
    // children, and not an empty list either (which would report a batch end nobody
    // recorded).
    await expect(driving).rejects.toThrow(/records no batch/)
    const run = await h.task.runIn(STORE, runId)
    expect(run.status).toBe('failed')
    expect(run.executionPhase).toBe('waiting_children')
    expect(run.batches ?? []).toEqual([])
    expect(h.relayed).toEqual([])
    expect(h.spawned).toEqual([])
  })

  test('an unreadable store is not answered as "the batch is not recorded"', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await h.runtime.awaitBatch(STORE, batchId)

    // A store whose read fails cannot be asked what it records: the failure is
    // reported as itself, never as the conclusion that the batch is not recorded —
    // a fact about the store's content a failed read does not know.
    vi.spyOn(h.task, 'snapshotIn').mockImplementation(async (storeId: string) => {
      throw new Error(`store "${storeId}" could not be read`)
    })
    await expect(h.runtime.awaitBatch(STORE, batchId)).rejects.toThrow(/could not be read/)
    await expect(h.runtime.redeliverBatchResult(STORE, batchId)).rejects.toThrow(/could not be read/)
    vi.restoreAllMocks()

    // The record is where it was: both entries answer again once the store is
    // readable, and the delivered batch-end message is the fold's, not a new one.
    expect((await h.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.taskId)).toHaveLength(1)
    expect(await h.runtime.redeliverBatchResult(STORE, batchId)).toBe('already-present')
  })
})
