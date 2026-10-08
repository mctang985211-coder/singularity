import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskService } from '../../task/src/index.ts'
import type { RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry, type ToolCallRecord } from '../support/scripted-loop.ts'

/**
 * A cancellation's write barrier against a record read around it, on the real
 * tool waterfall.
 *
 * `TaskRuntime.cancelGraph` closes the gate for every session of a store before
 * it persists the cancellation — §3.6's order is the promise: the gate, then the
 * drivers, then the settlement, then the jobs and the workspace. That order puts
 * the barrier in effect *ahead* of the record, and two reads of that record carry
 * a value older than the barrier into the gate. They are different trajectories
 * — one is a read inside the window, the other a read that straddled a decision
 * that has already been persisted — and each has its own reason to be inapplicable:
 *
 * 1. **A read taken inside the window.** While the cancellation is still running
 *    the store holds the run as `running` with phase `active`: a record older
 *    than the barrier, and one that predates nothing because the decision has not
 *    been written yet. Reads are pure since A2 (no read ever applies a phase),
 *    so the read leaves the barrier exactly where it is.
 * 2. **A read that straddled the decision.** A read starts before the
 *    cancellation and *returns* the old record — but the completion
 *    lands while that read is in flight, so by the time the value is applied the
 *    store already records the cancellation and the closing set is empty again.
 *    Nothing about the window applies; what makes the value inapplicable is the
 *    decision that landed between the read and its application, and the gate's
 *    own count of the decisions it made is what says so. With reads pure, the
 *    one store→gate application left is the recovery barrier's own, which is
 *    the read this case holds.
 *
 * `task_proposal_read` is the case-1 read: it now travels the context read core
 * (`resolveCaller`, a pure read). Case 2's held read is `adoptRoot`'s barrier
 * snapshot, the only path that still derives gate phases from the store; the
 * gate's token rule (`ExecutionGate.applyStorePhase`) is what refuses to apply
 * a value that predates a decision.
 *
 * Both cases end in the same three facts, and the third is what keeps the first
 * two from being a way of denying everything:
 *
 * 1. A write is denied *before its body runs* while a coordination read still
 *    answers from the store, and the barrier survives that read. The
 *    interleaving is decided by latches — in the first case the cancellation's
 *    own persistence is paused, in the second the query's read is held — never by
 *    a timing guess: the store's own implementation still runs, only its wait
 *    point is controlled.
 * 2. The same write tool is admitted in the legitimate `active` phase before the
 *    cancellation starts, so what is refused is the closed phase and not the tool.
 * 3. Once the barrier is released the cancellation lands: the store records the
 *    run cancelled and the session stays closed.
 *
 * Everything but the model's answers is the deployment's own code: the real DSH
 * loop, the real `TaskRuntime` mounted with `ctx.plugin` (so the real gate sits on
 * `tools/pre-execute`), the real coordination tools and the real store. The write
 * this case measures — `graph_spawn` — is the fixture's stand-in, because a body
 * that only records that it ran is what makes "the denial happened before any
 * effect" readable: it proves the body was never reached, and nothing about what
 * the real tool would have written to disk.
 */

const ROOT = 's-root' as SessionId

const ACTIVE_WRITE = 'write while the run decides its own work'
const WINDOW_ASK = 'read the proposal while the graph is being removed'
const BEFORE_READ = 'write before the read'
const AFTER_READ = 'write after the read'
const LATE_WRITE = 'write after the completion landed'

/** The root contract this store runs under (A0 §1.2): one goal, one criterion a command settles. */
const CONTRACT: RootContractSpec = {
  objective: 'ship the release', requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

afterEach(async () => {
  await disposeScriptedLoops()
})

/** The `ordinal`-th dispatch of one tool by one session, once it reported a result. */
async function answered(h: ScriptedLoop, name: string, ordinal = 0, sessionId: string | SessionId = ROOT): Promise<ToolCallRecord> {
  await vi.waitFor(() => {
    expect(h.calls.filter(call => call.name === name && call.sessionId === String(sessionId) && call.result !== undefined).length).toBeGreaterThan(ordinal)
  })
  return h.calls.filter(call => call.name === name && call.sessionId === String(sessionId))[ordinal]!
}

/** The answer text of one dispatched call. */
function textOf(call: ToolCallRecord): string {
  return call.result?.text ?? ''
}

/** The stand-in bodies of one tool that really ran, in dispatch order. */
function ran(h: ScriptedLoop, name: string): readonly string[] {
  return h.executed.filter(entry => entry.startsWith(`${name}:`))
}

/**
 * One call through the real registry and the real waterfall — the gate's own
 * decision, deny included — as the root session's own call. A direct call and a
 * scripted one travel the same pipeline, so a case whose subject is the read path
 * rather than the turn does not need a model request to reach it.
 */
async function throughPipeline(
  h: ScriptedLoop,
  callId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ isError: boolean; text: string }> {
  const answer = await h.ctx.tools.execute({
    callId,
    name,
    arguments: args,
    agent: { id: ROOT } as never,
    signal: new AbortController().signal,
  })
  return {
    isError: answer.isError === true,
    text: answer.content.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
  }
}

describe('a cancellation’s write barrier against the store’s older record', () => {
  it('denies a write after a coordination read in the window, and lands once its settlement is persisted', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const window = Promise.withResolvers<void>()
    let proposalId = ''
    const h = await startScriptedLoop({
      probes: ['graph_spawn'],
      script: (): readonly ScriptEntry[] => [
        // The legitimate `active` phase, before any cancellation: the very write
        // the window below refuses is admitted here and its body runs.
        { tool: 'graph_spawn', args: { reason: ACTIVE_WRITE } },
        // The turn parks here, so nothing below is dispatched until this spec
        // opens the window: the interleaving is the latch, not a race.
        { waitFor: () => window.promise },
        // The window: a write, a pure coordination read, and a write again —
        // the order is the whole defect.
        { tool: 'graph_spawn', args: { reason: BEFORE_READ } },
        { tool: 'task_proposal_read', args: () => ({ proposalId }) },
        { tool: 'graph_spawn', args: { reason: AFTER_READ } },
        { text: 'root: done reading' },
      ],
    })
    const root = await h.begin(CONTRACT)
    const proposals = (await h.snapshot(root.storeId)).proposals?.all ?? []
    expect(proposals).toHaveLength(1)
    proposalId = proposals[0]!.proposalId

    // The write is legitimate work while the run decides its own work, and the
    // evidence is the store's own phase plus a body that ran.
    expect(h.runtime.gate.phaseOf(ROOT)).toBe('active')
    const whileActive = await answered(h, 'graph_spawn')
    expect(whileActive.sessionId).toBe(String(ROOT))
    expect(whileActive.result?.isError).toBeFalsy()
    expect(textOf(whileActive)).toBe('graph_spawn: fixture answer')
    expect(ran(h, 'graph_spawn')).toHaveLength(1)
    expect(ran(h, 'graph_spawn')[0]).toContain(ACTIVE_WRITE)

    // The cancellation is paused inside its own window: the settling store write
    // is the wait point, so the gate is closed while the store has not been told
    // yet. The store's own implementation still runs — the pause controls where
    // the operation waits and nothing else.
    const storeMark = h.task.markRunStatusIn.bind(h.task)
    const persisted = vi.spyOn(h.task, 'markRunStatusIn').mockImplementation(async (...args: Parameters<TaskService['markRunStatusIn']>) => {
      if (args[0] === root.storeId && args[2] === root.runId && args[3] === 'cancelled') {
        entered.resolve()
        await release.promise
      }
      return await storeMark(...args)
    })
    const cancelling = h.runtime.cancelGraph(root.storeId, 'the graph was removed')
    try {
      await entered.promise
      // Inside the described window, both halves of it: the gate is closed and
      // the record the store holds is still the older one.
      expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')
      const inWindow = await h.task.runIn(root.storeId, root.runId)
      expect(inWindow.status).toBe('running')
      expect(inWindow.executionPhase).toBe('active')

      h.userSays(WINDOW_ASK)
      window.resolve()

      const beforeRead = await answered(h, 'graph_spawn', 1)
      expect(beforeRead.result?.isError).toBe(true)
      expect(textOf(beforeRead)).toContain('phase "terminal"')

      const read = await answered(h, 'task_proposal_read')
      expect(read.result?.isError).toBe(false)
      expect(textOf(read)).toContain(`proposal ${proposalId}`)
      expect(textOf(read)).toContain('ship the release')

      // The read went through the context read core (`resolveCaller`, a pure
      // read) and left the barrier exactly where the cancellation put it.
      expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')

      const afterRead = await answered(h, 'graph_spawn', 2)
      expect(afterRead.result?.isError).toBe(true)
      expect(textOf(afterRead)).toContain('phase "terminal"')
      // Neither window write reached a body: the only `graph_spawn` body that ran
      // is the `active`-phase one, and a denied call leaves nothing in flight.
      expect(ran(h, 'graph_spawn')).toHaveLength(1)
      expect(ran(h, 'graph_spawn')[0]).toContain(ACTIVE_WRITE)
      expect(h.runtime.gate.inFlightWrites(ROOT)).toEqual([])
      await vi.waitFor(() => {
        expect(h.requestsOf(ROOT).some(request => request.texts.includes(WINDOW_ASK))).toBe(true)
      })

      release.resolve()
      await cancelling

      // The cancellation landed, and the store — not this process's memory — is
      // what says so.
      const settled = await h.task.runIn(root.storeId, root.runId)
      expect(settled.status).toBe('cancelled')
      const snapshot = await h.snapshot(root.storeId)
      expect(snapshot.tasks.find(task => task.taskId === root.taskId)!.status).toBe('cancelled')
      expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')
    } finally {
      // A failed assertion above must not leave the barrier holding the
      // cancellation's own persistence: the latch is always released and the
      // operation always awaited.
      window.resolve()
      release.resolve()
      await cancelling.catch(() => undefined)
      persisted.mockRestore()
    }
  })

  it('drops a store read that straddled the completion, and keeps the gate closed', async () => {
    const turn = Promise.withResolvers<void>()
    const readEntered = Promise.withResolvers<void>()
    const readRelease = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      probes: ['graph_spawn'],
      script: (): readonly ScriptEntry[] => [
        // The root's own turn is parked for the whole case, so nothing else
        // dispatches into the session while the read below is held.
        { waitFor: () => turn.promise },
        { text: 'root: nothing further' },
      ],
    })
    const root = await h.begin(CONTRACT)

    // The write the late call below is measured against is admitted while the run
    // decides its own work, and its body runs: what the completed cancellation
    // refuses is the phase, not the tool.
    expect(h.runtime.gate.phaseOf(ROOT)).toBe('active')
    const whileActive = await throughPipeline(h, 'call-active-write', 'graph_spawn', { reason: ACTIVE_WRITE })
    expect(whileActive.isError).toBe(false)
    expect(ran(h, 'graph_spawn')).toHaveLength(1)
    expect(ran(h, 'graph_spawn')[0]).toContain(ACTIVE_WRITE)

    // The straddling read: a call-through spy on the store's own read. The read
    // door no longer writes the gate at all (A2 §E), so the one store→gate write
    // left is the recovery barrier's — `adoptRoot` derives each known session's
    // phase from the store, and initializes the gates from one read of it taken
    // under the gate's own token rule (`ExecutionGate.applyStorePhase`, whose
    // token branch is `task-runtime/tests/unit/gate.spec.ts`). That is the
    // trajectory this case is about: the real read runs and returns the record the
    // store holds, and only its *return* is held, so the value it carries out is
    // the one the store held before the decision below. The hold is armed for
    // exactly one read — the barrier's own — so the assertions inside the window
    // read the store normally.
    const storeSnapshot = h.task.snapshotIn.bind(h.task)
    let armed = true
    let barrierSettled = false
    const readSpy = vi.spyOn(h.task, 'snapshotIn').mockImplementation(async (...args: Parameters<TaskService['snapshotIn']>) => {
      const snapshot = await storeSnapshot(...args)
      if (args[0] === root.storeId && armed) {
        armed = false
        readEntered.resolve()
        await readRelease.promise
      }
      return snapshot
    })
    const adopting = h.runtime.adoptRoot(root.storeId, String(ROOT))
    void adopting.then(() => { barrierSettled = true }, () => { barrierSettled = true })
    try {
      await readEntered.promise
      // The held read is the barrier's own: the barrier is still unanswered while
      // it is held — so the value the release carries out of it is the value this
      // barrier read, not somebody else's.
      expect(barrierSettled).toBe(false)
      // Inside the read: the store still holds the older record, and that is the
      // value the barrier is about to carry out of it (a read taken *around* the
      // completion rather than inside the closing window).
      const atRead = await h.task.runIn(root.storeId, root.runId)
      expect(atRead.status).toBe('running')
      expect(atRead.executionPhase).toBe('active')

      // The real cancellation runs to its own end while the read is held: the
      // record is written and the gate is closed before the value is applied.
      await h.runtime.cancelGraph(root.storeId, 'the graph was removed')
      const settled = await h.task.runIn(root.storeId, root.runId)
      expect(settled.status).toBe('cancelled')
      expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')

      // The read is released: the barrier finishes with the record it read, and
      // the gate is exactly where the completion put it — a value read before a
      // decision may not be applied after it.
      readRelease.resolve()
      await adopting.catch(() => undefined)
      expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')

      // The late write is refused by name, and the fixture's stand-in body is
      // never reached — which proves the denial happened before any effect, and
      // nothing about what a real `graph_spawn` would have written.
      const lateWrite = await throughPipeline(h, 'call-late-write', 'graph_spawn', { reason: LATE_WRITE })
      expect(lateWrite.isError).toBe(true)
      expect(lateWrite.text).toContain('phase "terminal"')
      expect(ran(h, 'graph_spawn')).toHaveLength(1)
      expect(ran(h, 'graph_spawn')[0]).toContain(ACTIVE_WRITE)

      // The coordination read still answers in the closed phase, through the real
      // pipeline (registry and waterfall included).
      const lateRead = await throughPipeline(h, 'call-late-read', 'task_read', {})
      expect(lateRead.isError).toBe(false)
      expect(lateRead.text).toContain('objective: ship the release')
      expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')
      expect(h.runtime.gate.inFlightWrites(ROOT)).toEqual([])
    } finally {
      // A failed assertion above must not leave a latch holding a promise: the
      // read and the turn are always released, and the barrier is always awaited.
      readRelease.resolve()
      turn.resolve()
      await adopting.catch(() => undefined)
      readSpy.mockRestore()
    }
  })
})
