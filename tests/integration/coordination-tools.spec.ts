import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, startRunStack, type RunStack, type ToolCallResult } from '../support/run-stack.ts'

/**
 * A3 acceptance on the tool surface itself: the four coordination facts the
 * whole protocol rests on, driven through the real singularity tools over the
 * real runtime, store, agent plane and verifier — with the model loop the only
 * thing replaced (the `worker` hook).
 *
 * 1. `task_decompose` returns at admission: the batch id and the phase the
 *    caller is now in come back while the child is still running, which is what
 *    makes "wait for the children" a notification rather than a blocked call.
 * 2. `task_submit_result` is how a worker ends its run: the submission is the
 *    store's own record (phase `submitted`, origin `worker`, the summary as
 *    given), and the verdict the verifier reaches comes back as the tool's
 *    answer.
 * 3. `task_cancel` ends a batch that cannot finish: the abort reaches the child
 *    agent, the in-flight child is settled cancelled, and the parent follows.
 * 4. The read side shows the phase: `task_read` renders the coordination state
 *    the store holds, so a caller can tell "waiting on children" from "running"
 *    without asking the runtime.
 *
 * Everything asserted is read back from a durable surface — the store's runs,
 * tasks and events, and the answer a real tool returned — never from the
 * fixture's memory of what it scripted.
 */

const ROOT = 's-root' as SessionId

afterEach(async () => {
  await disposeRunStacks()
})

const children = (objective: string): DecomposeSpec['children'] => [{
  objective, requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

/** The batch id the store recorded on the parent run — the admission's own fact, not text scraped from an answer. */
async function batchIdOf(h: RunStack, storeId: string, runId: string): Promise<string> {
  const run = await h.task.runIn(storeId, runId)
  if (run.batchId === undefined) throw new Error(`run "${runId}" recorded no batch`)
  return run.batchId
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
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

describe('the coordination tools (A3)', () => {
  it('returns from task_decompose at admission, with the child still in flight', async () => {
    const release = Promise.withResolvers<void>()
    const h = await startRunStack({
      roots: [ROOT],
      tools: true,
      worker: async () => { await release.promise },
    })
    const root = await h.root(ROOT, rootContract('ship the release'))

    const answer = await h.call(h.rootAgent(ROOT), 'task_decompose', {
      reason: 'split the work',
      children: children('align the ball'),
    })
    expect(answer.isError).toBe(false)

    // The batch is the store's fact; the answer names the same id and the phase
    // the caller is now in, and says plainly that it did not wait.
    const batchId = await batchIdOf(h, root.storeId, root.runId)
    expect(answer.text).toContain(`batch ${batchId}`)
    expect(answer.text).toContain('does not wait for the batch')
    expect(answer.text).toContain('phase waiting_children')
    expect((await h.task.runIn(root.storeId, root.runId)).executionPhase).toBe('waiting_children')

    // The child really is in flight: spawned, its run running, not settled — so
    // the call above returned while the batch was still working.
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
    const childSession = h.spawns[0]!.sessionId
    const { run: childRun } = await h.runtime.runForSession(childSession)
    expect(childRun.status).toBe('running')
    expect(childRun.executionPhase).toBe('active')

    // The read side shows the phase from the store, not from memory: the root's
    // tree view names the child and the phase its run is in...
    const read = await h.call(h.rootAgent(ROOT), 'task_read', {})
    expect(read.text).toContain(`- ${childRun.taskId} [running] align the ball (run: running — phase active)`)
    // ...and the child's run record, with the same phase, is one reference read
    // away — the run id the tree view does not print is read by id (A2 §D).
    const byRef = await h.call(h.rootAgent(ROOT), 'context_read', { kind: 'run', ref: childRun.runId })
    expect(byRef.isError).toBe(false)
    expect(byRef.text).toContain(`run ${childRun.runId} of task ${childRun.taskId} [running] — phase active`)

    release.resolve()
    const outcomes = await h.runtime.awaitBatch(root.storeId, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The batch end hands the parent back its own execution and submits nothing
    // on its behalf (K1 §2): the run is `active` again with no verdict yet.
    const handedBack = await h.task.runIn(root.storeId, root.runId)
    expect(handedBack.executionPhase).toBe('active')
    expect(handedBack.submission).toBeUndefined()
    // …and only the parent's own submission starts its acceptance.
    const submitted = await h.runtime.submitResult(ROOT, { summary: 'the root hands in the batch result' })
    expect(submitted.status).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
    const parent = await h.task.runIn(root.storeId, root.runId)
    expect(parent.executionPhase).toBe('submitted')
    expect(parent.submission?.origin).toBe('worker')
  })

  it('lets a worker hand its run in through the real task_submit_result tool', async () => {
    let submitted: ToolCallResult | undefined
    let h!: RunStack
    h = await startRunStack({
      roots: [ROOT],
      tools: true,
      // The worker submits for itself here, so the fixture must not submit for it.
      submit: false,
      worker: async (_sessionId: SessionId, agent: Agent) => {
        submitted = await h.call(agent, 'task_submit_result', {
          summary: 'aligned the ball and ran the check',
          evidenceRefs: ['ev-worker-note'],
          notes: 'the fixtures are unchanged',
        })
      },
    })
    const root = await h.root(ROOT, rootContract('ship the release'))

    const answer = await h.call(h.rootAgent(ROOT), 'task_decompose', {
      reason: 'split the work',
      children: children('align the ball'),
    })
    expect(answer.isError).toBe(false)
    const batchId = await batchIdOf(h, root.storeId, root.runId)
    const outcomes = await h.runtime.awaitBatch(root.storeId, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // The tool answered with the verdict, and the submission it carried is the
    // store's own record of the run — the worker's own claim, not the runtime's.
    expect(submitted).toBeDefined()
    expect(submitted!.isError).toBe(false)
    expect(submitted!.text).toContain('task_submit_result verified')
    expect(submitted!.text).toContain(`run "${outcomes[0]!.runId}" submitted and verified`)
    const childRun = await h.task.runIn(root.storeId, outcomes[0]!.runId!)
    expect(childRun.executionPhase).toBe('submitted')
    expect(childRun.submission).toMatchObject({
      summary: 'aligned the ball and ran the check',
      evidenceRefs: ['ev-worker-note'],
      notes: 'the fixtures are unchanged',
      origin: 'worker',
    })
    // A self-check's evidence is not the submission's: the run's verdict came from
    // the verification the submission triggered, and its review is on the record.
    expect(childRun.status).toBe('verified')
    const review = (await h.snapshot(root.storeId)).reviews.find(item => item.runId === outcomes[0]!.runId!)
    expect(review?.outcome).toBe('verified')
    expect(review?.evidenceRefs.length).toBeGreaterThan(0)
  })

  it('cancels a batch through the real task_cancel tool, settling the child in flight', async () => {
    const release = Promise.withResolvers<void>()
    let h!: RunStack
    h = await startRunStack({
      roots: [ROOT],
      tools: true,
      submit: false,
      worker: async () => { await release.promise },
    })
    const root = await h.root(ROOT, rootContract('ship the release'))

    const answer = await h.call(h.rootAgent(ROOT), 'task_decompose', {
      reason: 'split the work',
      children: children('align the ball'),
    })
    expect(answer.isError).toBe(false)
    const batchId = await batchIdOf(h, root.storeId, root.runId)
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
    const childAgent = h.agent(h.spawns[0]!.sessionId)!

    // A live parent cancels its batch while the child runs; the abort reaches the
    // child's own agent, which is what stops its turn.
    const cancelling = h.call(h.rootAgent(ROOT), 'task_cancel', { reason: 'the plan changed' })
    await vi.waitFor(() => expect(childAgent.cancel).toHaveBeenCalledOnce())
    release.resolve()
    const cancelled = await cancelling

    expect(cancelled.isError).toBe(false)
    expect(cancelled.text).toContain(`cancelled batch ${batchId} (the plan changed):`)
    const outcomes = await h.runtime.awaitBatch(root.storeId, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    const snapshot = await h.snapshot(root.storeId)
    const childTaskId = snapshot.tasks.find(task => task.parentTaskId === root.taskId)!.taskId
    expect(snapshot.tasks.find(task => task.taskId === childTaskId)!.status).toBe('cancelled')
    // The parent is cancelled with its batch, and the reason is on the record.
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('cancelled')
    const parentReview = snapshot.reviews.find(item => item.taskId === root.taskId)
    expect(parentReview?.outcome).toBe('cancelled')
  })

  it('tells a run with no batch open that there is nothing to cancel', async () => {
    const h = await startRunStack({ roots: [ROOT], tools: true })
    await h.root(ROOT, rootContract('ship the release'))

    const cancelled = await h.call(h.rootAgent(ROOT), 'task_cancel', {})
    expect(cancelled.isError).toBe(false)
    expect(cancelled.text).toContain('no batch is in flight')
    expect(cancelled.text).toContain('phase active')
    expect(cancelled.text).toContain('nothing was changed')
    expect((await h.snapshot(`sg-t-${ROOT}`)).reviews).toHaveLength(0)
  })
})
