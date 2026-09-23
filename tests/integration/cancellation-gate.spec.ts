import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskService } from '../../task/src/index.ts'
import type { RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry, type ToolCallRecord } from '../support/scripted-loop.ts'

/**
 * A cancellation's write barrier against the record it has not written yet, on
 * the real tool waterfall.
 *
 * `TaskRuntime.cancelGraph` closes the gate for every session of a store before
 * it persists the cancellation — §3.6's order is the promise: the gate, then the
 * drivers, then the settlement, then the jobs and the workspace. For the length
 * of that window the store still holds those runs as `running` with phase
 * `active`, a record *older* than the barrier this process already put in effect,
 * and a read path that rebinds the session in the window used to re-apply it:
 * `task_proposal_read` reaches `runForSession` through `proposalStoreFor`, and the
 * refresh set the phase back to `active`, re-opening a barrier a cancellation
 * owned.
 *
 * Three facts, and the third is what keeps the first two from being a way of
 * denying everything:
 *
 * 1. Inside the window a write is denied *before its body runs* while a
 *    coordination read still answers from the store, and the barrier survives
 *    that read. The window is decided by a latch — the cancellation's own
 *    persistence is paused — never by a timing guess: the store's write still
 *    runs through the real implementation, only its wait point is controlled.
 *    The turn is paced the way the coordination spec paces its own
 *    "a closed phase denies a write" case: a scripted request parks on the latch
 *    the spec resolves.
 * 2. The same write tool is admitted in the legitimate `active` phase before the
 *    cancellation starts, so what the window refuses is the closed phase and not
 *    the tool.
 * 3. Once the persistence is released the cancellation lands: the store records
 *    the run cancelled and the session stays closed.
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

/** The root contract this store runs under (A0 §1.2): one goal, one criterion a command settles. */
const CONTRACT: RootContractSpec = {
  objective: 'ship the release',
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
        // The window: a write, the coordination read that reaches the rebinding
        // door, and a write again — the order is the whole defect.
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

      // The read went through the rebinding door (`runForSession`) and left the
      // barrier exactly where the cancellation put it.
      expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')

      const afterRead = await answered(h, 'graph_spawn', 2)
      expect(afterRead.result?.isError).toBe(true)
      expect(textOf(afterRead)).toContain('phase "terminal"')
      // Neither window write reached a body: the only `graph_spawn` body that ran
      // is the `active`-phase one, and a denied call leaves nothing in flight.
      expect(ran(h, 'graph_spawn')).toHaveLength(1)
      expect(ran(h, 'graph_spawn')[0]).toContain(ACTIVE_WRITE)
      expect(h.runtime.gate.inFlightWrites(ROOT)).toEqual([])
      expect(h.requestsOf(ROOT).some(request => request.texts.includes(WINDOW_ASK))).toBe(true)

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
})
