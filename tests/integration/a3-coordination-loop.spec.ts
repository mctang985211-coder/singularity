import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry } from '../support/scripted-loop.ts'

/**
 * A3 acceptance on the real loop: what a deployment's coordination protocol
 * does when the model is a real agent loop with a script behind it, not a hook.
 *
 * The four facts this spec exists for, none of which a runtime-level test can
 * show:
 *
 * 1. `task_decompose` returns at admission *inside a turn*: the root's own loop
 *    keeps going — it reads `task_status` and gets an answer — while the child it
 *    spawned is still mid-turn. The counter-example the ticket names (a loop
 *    that waits for the batch) fails this, and §4.3's "分解立即返回且父可继续" is
 *    exactly this ordering.
 * 2. A worker that goes idle without submitting is reminded once and stopped by
 *    the wall-clock budget, and the verifier never sees it: idle is not
 *    completion. The evidence is the two requests the adapter served for that
 *    session (turn one, the reminder), the store's deadline verdict, and the
 *    absence of any evidence bundle for the run.
 * 3. The execution gate is a real waterfall over the real tool registry: a write
 *    a closed phase does not admit is denied *before its body runs* (the fixture
 *    probe never fires), the coordination tools still answer, and a denied call
 *    leaves no in-flight registration behind. The root is denied a write it can
 *    see (`graph_spawn`, in its own allow-list) while it waits on its batch; a
 *    worker is denied `bash` once its run has settled — the root's composition
 *    holds no filesystem tools at all (`ROOT_TOOLS`), so a `bash` probe there
 *    would be refused for the wrong reason and would prove nothing.
 * 4. Cancelling a batch reaches the in-flight worker's own turn — its session log
 *    records the abort the agent was cancelled with — settles the child and the
 *    parent, spawns nothing further, and refuses a second cancellation by name
 *    without writing anything.
 *
 * Everything asserted is read from a durable surface (the store's events and
 * snapshot, the session log the loop appended through) or from the adapter's own
 * record of what it was asked. The only scripted thing is the model's answers.
 *
 * **Evidence that case 1 is decisive (2026-09-22).** With `decomposeAndRun`
 * temporarily restored to the pre-A3 shape — awaiting the driver it just
 * registered before returning — this spec's first case fails: `task_status` never
 * answers while the child is in flight (`expected undefined to be defined`), which
 * is the loop-waiting counter-example the acceptance row names. The temporary edit
 * was reverted immediately (the file's md5 was re-checked against a copy taken
 * before it).
 */

const ROOT = 's-root' as SessionId

afterEach(async () => {
  await disposeScriptedLoops()
})

/** One child spec: a goal and a criterion a command can settle. */
const children = (objective: string): DecomposeSpec['children'] => [{
  objective, requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

/**
 * The batch id the store recorded on the root run — the admission's own fact,
 * waited for. Read from the run's accumulated batches as well as its current
 * one: `run.batchId` is the *unfinished* batch, cleared by the batch end that
 * hands the run back `active` (K1 §1–§2), so a case whose batch settles quickly
 * still reads the identity it admitted rather than racing the handback.
 */
async function batchIdOf(h: ScriptedLoop): Promise<string> {
  let found: string | undefined
  await vi.waitFor(async () => {
    const { run } = await h.runForSession(ROOT)
    found = run.batches?.[0]?.batchId ?? run.batchId
    expect(found).toBeDefined()
  })
  return found!
}

/** The child session the runtime spawned, in spawn order. */
function childSession(h: ScriptedLoop, index = 0): string {
  const spawn = h.spawns[index]
  if (spawn === undefined) throw new Error(`no spawn ${index} was recorded`)
  return spawn.sessionId
}


/**
 * The root contract every case in this file runs under (A0 §1.2): one goal, one
 * criterion a command settles. The intake is the real one — a root exists only
 * because a contract passed it — so the contract is stated here explicitly rather
 * than defaulted: a root contract owes at least one mandatory criterion judged by
 * something other than the composite conjunction.
 */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release', requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

describe('the coordination protocol on the real loop (A3)', () => {
  it('returns from task_decompose at admission, and the root keeps working while the child is in flight', async () => {
    const childInFlight = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      // The root: decompose, then (once the child really is mid-turn) read the
      // tree, then finish its turn. The child stays in flight until this test
      // lets it go.
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_decompose', args: { reason: 'split the work', children: children('align the ball') } },
          { waitFor: () => childInFlight.promise },
          { tool: 'task_status', args: {} },
          { text: 'root: the batch is the runtime\'s now' },
        ]
        : [
          { waitFor: () => release.promise },
          { tool: 'task_submit_result', args: { summary: 'aligned the ball and ran the check' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)

    // Park the root's own turn until the child's run exists, so the ordering
    // below is the protocol's and not a scheduling accident.
    const batchId = await batchIdOf(h)
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
    const child = childSession(h)
    await vi.waitFor(async () => expect((await h.runForSession(child)).run.executionPhase).toBe('active'))
    childInFlight.resolve()

    // The root's own turn got past the decomposition while the child is still
    // mid-turn: `task_status` answered, and nothing submitted yet.
    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'task_status' && call.sessionId === ROOT)?.result).toBeDefined())
    const decomposed = h.calls.find(call => call.name === 'task_decompose')!
    const status = h.calls.find(call => call.name === 'task_status')!
    expect(decomposed.result?.isError).toBe(false)
    expect(decomposed.order).toBeLessThan(status.order)
    expect(status.result?.isError).toBe(false)
    // The answer is the store's own shape, and it says plainly that it didn't wait.
    expect(decomposed.result?.text).toContain(`batch ${batchId}`)
    expect(decomposed.result?.text).toContain('does not wait for the batch')
    expect(decomposed.result?.text).toContain('phase waiting_children')

    // The child really is in flight: spawned once, its run running and active,
    // its own turn parked on the latch, and no submission anywhere.
    expect(h.spawns).toHaveLength(1)
    const inFlight = await h.runForSession(child)
    expect(inFlight.run.status).toBe('running')
    expect(inFlight.run.executionPhase).toBe('active')
    expect(h.calls.some(call => call.name === 'task_submit_result')).toBe(false)
    expect((await h.task.runIn(root.storeId, root.runId)).executionPhase).toBe('waiting_children')

    release.resolve()
    const outcomes = await h.runtime.awaitBatch(root.storeId, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The child submitted for itself and was verified. The batch end then handed
    // the root back its own execution and judged nothing (K1 §2): the run reads
    // `active` with no submission of its own, and the task is not settled.
    expect((await h.task.runIn(root.storeId, inFlight.run.runId)).executionPhase).toBe('submitted')
    const handedBack = await h.task.runIn(root.storeId, root.runId)
    expect(handedBack.executionPhase).toBe('active')
    expect(handedBack.submission).toBeUndefined()
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('running')

    // The owner is told, in a new turn of its own loop: the batch-end message
    // under the identity the batch derives, carrying the children's terminal
    // states and the fact that nothing was submitted on the root's behalf. The
    // turn is found by what it carries rather than by its position — the intake's
    // own activation notice is another turn of the same session, and counting
    // turns would make this assertion depend on it.
    const endMessageId = `m-batchend-${batchId}`
    await vi.waitFor(() => expect(h.eventsOf(ROOT).some(event => event.type === 'user/message' && event.data.id === endMessageId)).toBe(true))
    await vi.waitFor(() => expect(h.requestsOf(ROOT).some(request => request.options.messages.some(message => message.id === endMessageId))).toBe(true))
    const notice = h.requestsOf(ROOT).find(request => request.options.messages.some(message => message.id === endMessageId))!
    expect(notice.texts.join('\n')).toContain('nothing was submitted on your behalf')
    expect(notice.texts.join('\n')).toContain('1 verified')
    // The wake is a relayed message in the runtime's own name, not a person's.
    const delivered = notice.options.messages.find(message => message.id === endMessageId)!
    expect(delivered).toBeDefined()
    expect(delivered.source).toMatchObject({ kind: 'agent-message', form: 'relay', senderSessionId: String(ROOT) })

    // …and only the root's own submission starts its acceptance (K1 §2).
    const settled = await h.runtime.submitResult(ROOT, { summary: 'the root hands in the result its batch produced' })
    expect(settled.status).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
    const parentRun = await h.task.runIn(root.storeId, root.runId)
    expect(parentRun.executionPhase).toBe('submitted')
    expect(parentRun.submission?.origin).toBe('worker')
  })

  it('keeps a staged result active through four idle turns, then accepts the worker submission', async () => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'split the work', children: children('staged child') } }]
        : [
          { waitFor: () => writeFile(join(h.checkout, 'stage.txt'), 'first stage complete') },
          { text: 'first stage complete' },
          { text: 'checkpoint acknowledged' },
          { text: 'next stage checked' },
          { text: 'another stage checked' },
          { tool: 'task_submit_result', args: { summary: 'completed the staged work', evidenceRefs: ['stage.txt'] } },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const batchId = await batchIdOf(h)
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
    const child = childSession(h)
    await vi.waitFor(() => expect(h.requestsOf(child)).toHaveLength(2))
    await h.agent(child).whenIdle()
    expect(await readFile(join(h.checkout, 'stage.txt'), 'utf8')).toBe('first stage complete')

    for (let turns = 3; turns <= 4; turns += 1) {
      h.pluginSays('continue with the next stage', child)
      await vi.waitFor(() => expect(h.requestsOf(child)).toHaveLength(turns))
      await h.agent(child).whenIdle()
      expect((await h.runForSession(child)).run.status).toBe('running')
    }
    expect(h.eventsOf(root.storeId).filter(event => event.type === 'task/event' && (event.data as { kind?: string }).kind === 'RunProgressMarked')).toHaveLength(0)
    h.pluginSays('submit the completed result', child)
    const outcomes = await h.runtime.awaitBatch(root.storeId, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await h.runForSession(child)).run.submission?.evidenceRefs).toEqual(['stage.txt'])
  })

  it('denies a write a closed phase does not admit, on the real tool waterfall, while the reads still answer', async () => {
    const childInFlight = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      probes: ['graph_spawn', 'bash'],
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_decompose', args: { reason: 'split the work', children: children('align the ball') } },
          { waitFor: () => childInFlight.promise },
          // A write the root's own composition offers, attempted in the phase
          // where admission has already closed.
          { tool: 'graph_spawn', args: { reason: 'spin up another node' } },
          { tool: 'task_read', args: {} },
          { text: 'root: done coordinating' },
        ]
        : [
          { waitFor: () => release.promise },
          { tool: 'task_submit_result', args: { summary: 'aligned the ball' } },
          // The worker's composition does hold the filesystem tools, so this is
          // where a write is denied for the phase rather than for the surface.
          { tool: 'bash', args: { command: 'touch should-not-exist' } },
          { tool: 'read', args: { path: 'README.md' } },
          { tool: 'task_read', args: {} },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    // The batch is admitted and the child is truly mid-turn before the root's
    // next request runs, so every call below is judged in waiting_children.
    const batchId = await batchIdOf(h)
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
    const child = childSession(h)
    await vi.waitFor(async () => expect((await h.runForSession(child)).run.executionPhase).toBe('active'))
    childInFlight.resolve()

    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'graph_spawn')?.result).toBeDefined())
    const denied = h.calls.find(call => call.name === 'graph_spawn')!
    expect(denied.sessionId).toBe(ROOT)
    expect(denied.result?.isError).toBe(true)
    expect(denied.result?.text).toContain('phase "waiting_children"')
    expect(denied.result?.text).toContain('Allowed in this phase: the coordination and read-only tools')
    // The body never ran: the probe is empty, so the denial happened before any
    // effect, and the denial left no in-flight registration behind.
    expect(h.executed.some(name => name.startsWith('graph_spawn'))).toBe(false)
    expect(h.runtime.gate.inFlightWrites(ROOT)).toEqual([])

    // A read in the same phase still answers, from the store: the batch is in
    // flight and the root can see exactly that.
    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'task_read' && call.sessionId === ROOT)?.result).toBeDefined())
    const read = h.calls.find(call => call.name === 'task_read' && call.sessionId === ROOT)!
    expect(read.result?.isError).toBe(false)
    expect(read.result?.text).toContain('children: 1')
    expect(read.result?.text).toContain('phase active')

    release.resolve()
    await h.runtime.awaitBatch(root.storeId, batchId)

    // The worker's run had already settled by the time its next turn asked for
    // those tools, so both names are late calls: the write is denied, the reads
    // answer. Which phase a call is judged in is the store's own fact.
    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'bash' && call.sessionId === child)?.result).toBeDefined())
    const late = h.calls.find(call => call.name === 'bash' && call.sessionId === child)!
    expect(late.result?.isError).toBe(true)
    expect(late.result?.text).toContain('phase "terminal"')
    expect(late.result?.text).toContain('late call')
    expect(h.executed.some(name => name.startsWith('bash'))).toBe(false)

    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'read' && call.sessionId === child)?.result).toBeDefined())
    const allowed = h.calls.find(call => call.name === 'read' && call.sessionId === child)!
    expect(allowed.result?.isError).toBe(false)
    expect(allowed.result?.text).toContain('read: fixture answer')
    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'task_read' && call.sessionId === child)?.result).toBeDefined())
    const workerRead = h.calls.find(call => call.name === 'task_read' && call.sessionId === child)!
    expect(workerRead.result?.isError).toBe(false)
    // A denied call is not an in-flight write: nothing is left to drain for that
    // session, which is why the batch could settle without a convergence failure.
    expect(h.runtime.gate.inFlightWrites(child)).toEqual([])
    // The batch end gave the root back its execution and judged nothing (K1 §2);
    // the root's own submission is what settles the tree's acceptance.
    expect((await h.task.runIn(root.storeId, root.runId)).executionPhase).toBe('active')
    await h.runtime.submitResult(ROOT, { summary: 'the root hands in the result its batch produced' })
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
  })

  it('cancels a batch with a worker in flight, and cannot cancel it twice', async () => {
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'split the work', children: children('long child') } }]
        // The worker never finishes on its own: only the cancellation ends it.
        : [{ hang: true }],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const batchId = await batchIdOf(h)
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
    const child = childSession(h)
    const childRun = (await h.runForSession(child)).run
    expect(childRun.status).toBe('running')

    const outcomes = await h.runtime.cancelBatch(root.storeId, batchId, ROOT)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.runs.find(run => run.runId === childRun.runId)?.status).toBe('cancelled')
    expect(snapshot.reviews.find(review => review.runId === childRun.runId)?.outcome).toBe('cancelled')
    expect((await h.task.runIn(root.storeId, root.runId)).status).toBe('cancelled')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('cancelled')

    // The cancellation reached the worker's own loop: its session log records the
    // turn ending under the parent's cancel cause, which is the abort the driver
    // sends (`awaitWorker` cancels with `{ kind: 'parent' }`).
    const turnEnds = h.eventsOf(child).filter(event => event.type === 'turn/end')
    expect(turnEnds.length).toBeGreaterThan(0)
    expect(turnEnds[turnEnds.length - 1]!.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'parent' } } })

    // Nothing further is started, and the batch's own registration is gone: a
    // second cancellation is refused by name and writes nothing.
    const reviews = snapshot.reviews.length
    const spawns = h.spawns.length
    await expect(h.runtime.cancelBatch(root.storeId, batchId, ROOT)).rejects.toThrow(/not in flight/)
    const after = await h.snapshot(root.storeId)
    expect(after.reviews).toHaveLength(reviews)
    expect(h.spawns).toHaveLength(spawns)
    expect(after.runs.find(run => run.runId === childRun.runId)?.status).toBe('cancelled')
  })

  it('cancels a batch whose child is itself waiting on a nested batch, through the real task_cancel tool', async () => {
    // The nested shape: the root decomposes, the child decomposes in turn (its
    // run becomes `waiting_children`), the first grandchild hangs and the second
    // never starts because it depends on the first. The root's driver is parked
    // on the child's run, which is exactly where a batch cancellation has to
    // still be observed (A3 §3.1/§3.6).
    const childWaiting = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_decompose', args: { reason: 'split the work', children: children('child') } },
          // Parked until the child really is waiting on its own batch.
          { waitFor: () => childWaiting.promise },
          { tool: 'task_cancel', args: { reason: 'the plan changed' } },
          { text: 'root: the batch is over' },
        ]
        : index === 1
          ? [
            {
              tool: 'task_decompose',
              args: {
                reason: 'split it again',
                children: [children('grandchild one')[0]!, { ...children('grandchild two')[0]!, dependsOn: [0] }],
              },
            },
            { text: 'child: the grandchild is the runtime\'s now' },
          ]
          // The grandchild never finishes on its own: only the cancellation ends it.
          : [{ hang: true }],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const batchId = await batchIdOf(h)
    await vi.waitFor(() => expect(h.spawns).toHaveLength(2))
    const child = childSession(h)
    const grandchild = h.spawns[1]!.sessionId
    await vi.waitFor(async () => {
      expect((await h.runForSession(child)).run.executionPhase).toBe('waiting_children')
    })
    childWaiting.resolve()

    // The tool call itself is the bound: a cancellation the driver never observes
    // would never return, and this test would time out instead of asserting.
    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'task_cancel')?.result).toBeDefined())
    const cancelled = h.calls.find(call => call.name === 'task_cancel')!
    expect(cancelled.result?.isError).toBe(false)
    expect(cancelled.result?.text).toContain(`cancelled batch ${batchId}`)

    // The whole shape is settled, read back from the store: the child that waited,
    // the grandchild in flight, the grandchild that never started, and the root.
    const snapshot = await h.snapshot(root.storeId)
    const childRun = snapshot.runs.find(run => run.sessionId === child)!
    expect(childRun.status).toBe('cancelled')
    expect(snapshot.reviews.find(review => review.runId === childRun.runId)?.outcome).toBe('cancelled')
    const grandchildRuns = snapshot.runs.filter(run => run.taskId !== root.taskId && run.taskId !== childRun.taskId)
    expect(grandchildRuns.map(run => run.status)).toEqual(['cancelled'])
    const neverStarted = snapshot.tasks.find(task =>
      task.parentTaskId === childRun.taskId && !grandchildRuns.some(run => run.taskId === task.taskId))
    expect(neverStarted?.status).toBe('blocked')
    expect(snapshot.reviews.find(review => review.taskId === neverStarted?.taskId)?.anomalies.join(' '))
      .toContain('cancelled by the caller before this child started')
    expect((await h.task.runIn(root.storeId, root.runId)).status).toBe('cancelled')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('cancelled')

    // The abort reached the hung grandchild's own loop and nothing else started.
    const turnEnds = h.eventsOf(grandchild).filter(event => event.type === 'turn/end')
    expect(turnEnds.length).toBeGreaterThan(0)
    expect(turnEnds[turnEnds.length - 1]!.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'parent' } } })
    expect(h.spawns).toHaveLength(2)
  })

  it('cancels a batch whose child is inside verification, through the real task_cancel tool', async () => {
    // The other phase a parent parks on: the child handed its result in and the
    // verifier is still running, so the child's run is `submitted` and the root's
    // driver waits on that run's terminal state. A cancellation has to reach it
    // there too, and the verdict that arrives afterwards is voided.
    const childSubmitted = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      verifyTimeoutMs: 30_000,
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          {
            tool: 'task_decompose',
            args: {
              reason: 'split the work',
              children: [{
                objective: 'slow child', requiredCapabilities: ['execute-task'],
                acceptanceCriteria: [{ description: 'the slow child works', command: 'sleep 1' }],
              }],
            },
          },
          { waitFor: () => childSubmitted.promise },
          { tool: 'task_cancel', args: { reason: 'the plan changed' } },
          { text: 'root: the batch is over' },
        ]
        : [
          { tool: 'task_submit_result', args: { summary: 'the slow child is done' } },
          { text: 'child: handed in' },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const batchId = await batchIdOf(h)
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
    const child = childSession(h)
    await vi.waitFor(async () => {
      expect((await h.runForSession(child)).run.executionPhase).toBe('submitted')
    })
    childSubmitted.resolve()

    // The verification this child is inside runs for a second: the cancellation
    // reaches the child's own turn when that call returns, which is the bound the
    // tool call waits under.
    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'task_cancel')?.result).toBeDefined(), { timeout: 15_000 })
    const cancelled = h.calls.find(call => call.name === 'task_cancel')!
    expect(cancelled.result?.isError).toBe(false)
    expect(cancelled.result?.text).toContain(`cancelled batch ${batchId}`)

    const snapshot = await h.snapshot(root.storeId)
    const childRun = snapshot.runs.find(run => run.sessionId === child)!
    expect(childRun.status).toBe('cancelled')
    expect((await h.task.runIn(root.storeId, root.runId)).status).toBe('cancelled')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('cancelled')
    // The verdict the verifier was still working on is voided: one review record,
    // the cancellation's.
    await vi.waitFor(() => expect(h.eventsOf(root.storeId).some(event =>
      event.type === 'task/event' && (event.data as { kind?: string }).kind === 'TaskVerifying' && (event.data as { taskId?: string }).taskId === childRun.taskId)).toBe(true))
    const reviews = (await h.snapshot(root.storeId)).reviews.filter(review => review.runId === childRun.runId)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.outcome).toBe('cancelled')
  })
})
