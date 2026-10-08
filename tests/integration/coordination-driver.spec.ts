/**
 * The coordination driver on the real deployment: a current graph that carries
 * `rsi` settings has its rounds scheduled from the platform — one supervisor per
 * terminal root round, one next round opened through the runtime's own recovery
 * entry, and no re-prompt: a session that ends its turn without calling
 * `supervisor_complete` is a protocol failure.
 *
 * Everything except the model is the deployment's own: the real DSH loop with a
 * scripted provider, the real `AgentRuntime`/`AgentLoop`, the real `TaskRuntime`,
 * the real task store, and the real coordination file.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { CoordinationDriver } from '../../agent-singularity/src/coordination/driver.ts'
import { roundDiagnosisId, roundRequestKey } from '../../agent-singularity/src/coordination/rounds.ts'
import { coordinationFile, readCoordinationRows } from '../../agent-singularity/src/coordination/store.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)
const GRAPH = 'g1'
const RSI = { task: 'keep the delivered answer method improving', iterationRounds: 2, humanReview: false }

const criterion = (command: string) => [{ criterionId: 'goal', description: 'the delivered answer holds', command, verifierRef: 'command' }]

let coordination: string
let previous: string | undefined

beforeEach(() => {
  coordination = mkdtempSync(join(tmpdir(), 'coordination-driver-'))
  previous = process.env.SINGULARITY_COORDINATION_DIR
  process.env.SINGULARITY_COORDINATION_DIR = coordination
})

afterEach(async () => {
  await disposeScriptedLoops()
  if (previous === undefined) delete process.env.SINGULARITY_COORDINATION_DIR
  else process.env.SINGULARITY_COORDINATION_DIR = previous
  rmSync(coordination, { recursive: true, force: true })
})

/** The completion call the supervisor scripts, with evidence the store really holds. */
const complete = (h: () => ScriptedLoop, root: () => { taskId: string; runId: string }): ScriptEntry => ({
  tool: 'supervisor_complete',
  args: () => ({
    businessAction: 'continue',
    reason: 'the delivered method can be improved',
    evidenceRefs: [`${root().taskId}#${root().runId}`],
  }),
})

/** The root submits; the supervisor concludes with the completion tool. */
function scriptOf(
  h: () => ScriptedLoop,
  root: () => { taskId: string; runId: string },
): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, index): readonly ScriptEntry[] => {
    const name = h().spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
    if (name.startsWith('rsi supervisor')) return [complete(h, root)]
    if (index === 0) return [{ tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
    return [{ text: 'idle' }]
  }
}

async function drive(h: ScriptedLoop, graph = GRAPH): Promise<CoordinationDriver> {
  const driver = new CoordinationDriver(h.ctx, { log: () => {}, fallbackMs: 20, settleGraceMs: 500 })
  driver.install()
  await driver.wake(graph)
  return driver
}

describe('the coordination driver on the real deployment', () => {
  it('assigns before the spawn, supervises the verified round, and opens its improvement round after the completion', async () => {
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    h = await startScriptedLoop({ rsi: RSI, script: scriptOf(() => h, () => root) })
    root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()
    expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified')

    const driver = await drive(h)
    try {
      await vi.waitFor(() => expect(h.spawns.some(spawn => spawn.name.startsWith('rsi supervisor'))).toBe(true), { timeout: 10_000 })
      const supervisor = h.spawns.find(spawn => spawn.name.startsWith('rsi supervisor'))!

      // The assignment was on the file before the session reached model input.
      const rows = (await readCoordinationRows())!
      expect(rows).toEqual([
        expect.objectContaining({
          kind: 'assignment',
          graphId: GRAPH,
          storeId: STORE,
          role: 'supervisor',
          sessionId: supervisor.sessionId,
          subject: expect.objectContaining({ kind: 'round', businessRound: 1, searchRound: 1 }),
        }),
      ])
      expect(readFileSync(coordinationFile(), 'utf8')).toContain(supervisor.sessionId)

      // The completion is the supervisor's own, and it closed the session.
      await vi.waitFor(
        async () => {
          const after = (await readCoordinationRows()) ?? []
          expect(after.some(row => row.kind === 'completion' && row.sessionId === supervisor.sessionId)).toBe(true)
        },
        { timeout: 10_000 },
      )
      const completion = (await readCoordinationRows())!.find(row => row.kind === 'completion')!
      expect(completion).toMatchObject({
        kind: 'completion',
        role: 'supervisor',
        result: expect.objectContaining({ kind: 'completed', businessAction: 'continue', reason: 'the delivered method can be improved' }),
      })
      expect((completion.result as { methodDecision: string }).methodDecision).toBe('retain')
      expect((completion.result as { searchNext: string }).searchNext).toBe('explore')

      // The driver opened the next round through the runtime's recovery entry,
      // and recorded the round's platform diagnosis first so the recovery had a
      // record to name.
      await vi.waitFor(
        async () => {
          const started = await h.snapshot(root.storeId)
          const next = started.runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 1, 2))
          expect(next?.recovery).toMatchObject({
            kind: 'improvement',
            sourceDiagnosisId: roundDiagnosisId(GRAPH, 1, 1),
            sourceRunId: root.runId,
            reusedMembers: [],
          })
        },
        { timeout: 20_000 },
      )
      const started = await h.snapshot(root.storeId)
      expect(started.diagnoses.find(item => item.diagnosisId === roundDiagnosisId(GRAPH, 1, 1))).toMatchObject({
        taskId: root.taskId,
        proposals: [],
      })
      // A supervisor spoke once: no re-prompt chain exists any more.
      expect(h.spawns.filter(spawn => spawn.name.startsWith('rsi supervisor'))).toHaveLength(1)
    } finally {
      driver.stop()
    }
  }, 60_000)

  it('records a protocol failure when the supervisor ends its turn without calling the tool, and never asks again', async () => {
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    h = await startScriptedLoop({
      rsi: RSI,
      script: (sessionId, index): readonly ScriptEntry[] => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('rsi supervisor')) return [{ text: 'I looked at the round and have nothing to add.' }]
        if (index === 0) return [{ tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
        return [{ text: 'idle' }]
      },
    })
    root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()

    const driver = await drive(h)
    try {
      await vi.waitFor(
        async () => {
          const rows = (await readCoordinationRows()) ?? []
          expect(rows.some(row => row.kind === 'completion' && row.result.kind === 'protocol-failure')).toBe(true)
        },
        { timeout: 20_000 },
      )
      const rows = (await readCoordinationRows())!
      const failure = rows.find(row => row.kind === 'completion')!
      expect(failure).toMatchObject({
        kind: 'completion',
        role: 'supervisor',
        result: expect.objectContaining({ kind: 'protocol-failure' }),
      })
      // Nothing was opened for the round and no second supervisor was asked.
      const snapshot = await h.snapshot(root.storeId)
      expect(snapshot.runs.some(run => run.recovery !== undefined)).toBe(false)
      const supervisors = h.spawns.filter(spawn => spawn.name.startsWith('rsi supervisor'))
      expect(supervisors).toHaveLength(1)
      const supervisor = supervisors[0]!
      // The supervisor never called the completion tool: the platform neither
      // invented a completion for it nor asked it a second time.
      const asked = h.calls.filter(call => call.sessionId === supervisor.sessionId)
      expect(asked.some(call => call.name === 'supervisor_complete')).toBe(false)
    } finally {
      driver.stop()
    }
  }, 60_000)

  it('restarts onto the same work item: a second driver instance reuses the assignment instead of spawning again', async () => {
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    h = await startScriptedLoop({
      rsi: RSI,
      script: (sessionId, index): readonly ScriptEntry[] => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('rsi supervisor')) return [{ waitFor: async () => { await new Promise(resolve => setTimeout(resolve, 200)) } }, complete(() => h, () => root)]
        if (index === 0) return [{ tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
        return [{ text: 'idle' }]
      },
    })
    root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()

    const first = await drive(h)
    try {
      await vi.waitFor(() => expect(h.spawns.some(spawn => spawn.name.startsWith('rsi supervisor'))).toBe(true), { timeout: 10_000 })
      const sessionId = h.spawns.find(spawn => spawn.name.startsWith('rsi supervisor'))!.sessionId
      // A second process (a new driver) reads the same assignment and waits for it.
      const second = await drive(h)
      try {
        await second.wake(GRAPH)
        expect(h.spawns.filter(spawn => spawn.name.startsWith('rsi supervisor'))).toHaveLength(1)
        expect((await readCoordinationRows())![0]).toMatchObject({ sessionId })
      } finally {
        second.stop()
      }
    } finally {
      first.stop()
    }
  }, 60_000)

  it('does not schedule a sealed legacy graph', async () => {
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    h = await startScriptedLoop({ rsi: RSI, script: scriptOf(() => h, () => root) })
    root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()
    // The registry's own record loses its marker: the graph is sealed history.
    const graphs = h.ctx.get('graphs') as { get(id: string): Promise<Record<string, unknown>> }
    const original = await graphs.get(GRAPH)
    vi.spyOn(graphs, 'get').mockImplementation(async (id: string) => {
      const record = await Promise.resolve(original)
      const { protocol: _dropped, ...rest } = record
      void id
      return rest
    })
    const driver = new CoordinationDriver(h.ctx, { log: () => {}, fallbackMs: 20 })
    driver.install()
    try {
      await driver.wake(GRAPH)
      expect(h.spawns.filter(spawn => spawn.name.startsWith('rsi supervisor'))).toEqual([])
      expect((await readCoordinationRows()) ?? []).toEqual([])
    } finally {
      driver.stop()
      vi.restoreAllMocks()
    }
  }, 60_000)
})
