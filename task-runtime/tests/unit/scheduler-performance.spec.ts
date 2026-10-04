import { performance } from 'node:perf_hooks'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { TaskState } from '../../../task/src/index.ts'
import type { DependencyEdge, TaskInstance, TaskRun, TaskService, TaskSnapshot } from '../../../task/src/index.ts'
import { deriveChildOutcomes } from '../../src/orchestration/child.ts'
import { batchItems, latestRun, waitRunTerminal } from '../../src/orchestration/observe.ts'
import type { OrchestrateEnv } from '../../src/orchestration/types.ts'
import {
  childSpec,
  createRoot,
  decomposeAndSettle,
  harness,
  ROOT_SESSION,
  seedProducer,
  STORE,
} from './orchestrate.fixture.ts'

/** Historical tasks precede the current batch, as they do after many parent handbacks. */
function settledHistory(total: number, members: number): { snapshot: TaskSnapshot; memberTaskIds: string[] } {
  const tasks: TaskInstance[] = Array.from({ length: total }, (_, index) => ({
    taskId: `t-${index}`,
    definitionRef: { taskType: 'scheduler-fixture', version: 1 },
    objective: `task ${index}`,
    depth: index === 0 ? 0 : 1,
    ...(index === 0 ? {} : { parentTaskId: 't-0' }),
    acceptanceCriteria: [],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'verified',
    runIds: [`r-${index}`],
    childTaskIds: [],
  }))
  const runs: TaskRun[] = tasks.map((task, index) => ({
    runId: `r-${index}`,
    taskId: task.taskId,
    sessionId: `s-${index}`,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'verified',
    startedAt: '2026-10-05T00:00:00.000Z',
  }))
  const memberTaskIds = tasks.slice(-members).map(task => task.taskId)
  const edges = tasks.slice(1).map((task, index) => ({ from: tasks[index]!.taskId, to: task.taskId }))
  return {
    memberTaskIds,
    snapshot: {
      ...new TaskState('scheduler-fixture').snapshot(),
      tasks,
      runs,
      edges,
      evidence: runs.map(run => ({
        evidenceId: `e-${run.runId}`,
        taskId: run.taskId,
        taskRunId: run.runId,
        artifacts: [],
        verifierResults: [],
        claims: [],
        generatedAt: run.startedAt,
      })),
    },
  }
}

describe('scheduler long DAG regression', () => {
  test('one runtime overlaps replay drivers in separate checkouts while each checkout keeps its own writer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scheduler-independent-workspaces-'))
    const workspaces = [join(directory, 'checkout-a'), join(directory, 'checkout-b')]
    const h = harness({ config: { runBindingRoot: join(directory, 'bindings') } })
    let release!: () => void
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const started = new Map<string, string>()
    try {
      for (const workspace of workspaces) await mkdir(workspace)
      await createRoot(h)
      const champion = await seedProducer(h, { outcome: 'verified', kind: 'parallel-reference' })
      h.setIdleBehavior(async sessionId => {
        const bound = await h.runtime.runForSession(sessionId)
        const workspace = h.runtime.sessionWorkspaces.get(sessionId)!
        started.set(workspace, bound.task.taskId)
        await barrier
        await writeFile(join(workspace, 'result.txt'), bound.task.taskId)
        await h.runtime.submitResult(sessionId, { summary: 'the isolated checkout has its own result' })
      })
      // Both checkouts exist and differ before either write-capable driver starts.
      const replays = workspaces.map((workspace, index) =>
        h.runtime.replayTask(
          STORE,
          champion.taskId,
          {
            lineage: `evolution-replay:independent-${index}`,
            workspace: { path: workspace },
          },
          ROOT_SESSION,
        ),
      )
      for (const replay of replays) replay.catch(() => {})
      await vi.waitFor(() => expect(started.size).toBe(2))
      expect(h.runtime.drivers.size).toBe(2)
      expect(h.spawned.map(call => call.cwd).sort()).toEqual([...workspaces].sort())
      for (const workspace of workspaces) {
        expect(h.runtime.workspaces.ownerOf(workspace)).toMatchObject({ kind: 'run', taskId: started.get(workspace) })
      }
      release()
      const outcomes = await Promise.all(replays)
      expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
      for (const outcome of outcomes) {
        expect(await readFile(join(outcome.workspace!, 'result.txt'), 'utf8')).toBe(outcome.taskId)
        expect(h.runtime.workspaces.ownerOf(outcome.workspace!)).toBeUndefined()
      }
      expect((await h.task.taskIn(STORE, champion.taskId)).status).toBe('verified')
    } finally {
      release()
      await h.runtime.unload()
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  test('a reverse-index chain starts only after its producer verifies and hands back every member', async () => {
    const length = 32
    const h = harness({ config: { maxChildren: length } })
    const { taskId, runId } = await createRoot(h)
    const order: string[] = []
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      const snapshot = await h.task.snapshotIn(STORE)
      for (const edge of snapshot.edges.filter(edge => edge.to === bound.task.taskId)) {
        expect(snapshot.tasks.find(task => task.taskId === edge.from)?.status).toBe('verified')
      }
      order.push(bound.task.objective)
      await h.runtime.submitResult(sessionId, { summary: 'producer verified before this consumer started' })
    })
    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'a long chain whose ready node is last in batch order',
      children: Array.from({ length }, (_, index) =>
        childSpec(`chain ${index}`, {
          dependsOn: index + 1 < length ? [index + 1] : [],
        }),
      ),
    })
    expect(order).toEqual(Array.from({ length }, (_, index) => `chain ${length - index - 1}`))
    expect(outcomes.map(outcome => outcome.status)).toEqual(Array(length).fill('verified'))
    expect(outcomes.every(outcome => outcome.runId !== undefined && outcome.evidenceId !== undefined)).toBe(true)
    expect(await h.task.runIn(STORE, runId)).toMatchObject({ status: 'running', executionPhase: 'active' })
  }, 20_000)

  test('a failed producer blocks the remaining chain without spawning its consumers', async () => {
    const length = 24
    const failed = 11
    const h = harness({ config: { maxChildren: length }, verifier: 'by-objective' })
    const { taskId, runId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'propagate one failed dependency through a long chain',
      children: Array.from({ length }, (_, index) =>
        childSpec(index === failed ? 'fail-me' : `chain ${index}`, {
          dependsOn: index + 1 < length ? [index + 1] : [],
        }),
      ),
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual([
      ...Array(failed).fill('blocked'),
      'failed',
      ...Array(length - failed - 1).fill('verified'),
    ])
    expect(h.spawned).toHaveLength(length - failed)
    expect(outcomes.slice(0, failed).every(outcome => outcome.runId === undefined)).toBe(true)
  }, 20_000)

  test('batch edge lookup scales with edges while retaining sorted in-batch dependencies', () => {
    const { snapshot, memberTaskIds } = settledHistory(4_096, 512)
    let reads = 0
    const edges: DependencyEdge[] = snapshot.edges.map(edge => ({
      get to() {
        reads++
        return edge.to
      },
      from: edge.from,
    }))
    edges.push({ from: memberTaskIds[1]!, to: memberTaskIds[3]! })
    const items = batchItems(memberTaskIds, edges.reverse())
    expect(items[0]!.dependsOn).toEqual([])
    expect(items[3]!.dependsOn).toEqual([1, 2])
    expect(items.at(-1)!.dependsOn).toEqual([memberTaskIds.length - 2])
    expect(reads).toBeLessThanOrEqual(edges.length * 2)
  })

  test('a long store history preserves the latest retry and first evidence in batch outcomes', async () => {
    const { snapshot, memberTaskIds } = settledHistory(4_096, 512)
    const original = snapshot.runs.at(-1)!
    const retry: TaskRun = { ...original, runId: 'r-retry' }
    const firstEvidence = { ...snapshot.evidence.at(-1)!, evidenceId: 'e-retry-first', taskRunId: retry.runId }
    const secondEvidence = { ...firstEvidence, evidenceId: 'e-retry-second' }
    const withRetry: TaskSnapshot = {
      ...snapshot,
      runs: [...snapshot.runs, retry],
      evidence: [...snapshot.evidence, firstEvidence, secondEvidence],
    }
    let reads = 0
    const countedTasks = withRetry.tasks.map(task => ({
      ...task,
      get taskId() {
        reads++
        return task.taskId
      },
    }))
    const task = { snapshotIn: async () => ({ ...withRetry, tasks: countedTasks }) } as unknown as TaskService
    const outcomes = await deriveChildOutcomes(task, snapshot.id, 't-0', memberTaskIds)
    expect(outcomes.at(-1)).toEqual({
      taskId: original.taskId,
      runId: retry.runId,
      status: 'verified',
      evidenceId: 'e-retry-first',
    })
    expect(outcomes).toHaveLength(memberTaskIds.length)
    expect(reads).toBeLessThanOrEqual(withRetry.tasks.length * 2)

    let runReads = 0
    const runs = new Proxy(withRetry.runs, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) runReads++
        return Reflect.get(target, property, receiver)
      },
    })
    expect(latestRun({ ...withRetry, runs }, retry.taskId)).toBe(retry)
    expect(runReads).toBeLessThanOrEqual(2)
  })

  test('a watcher that reports terminal synchronously is unsubscribed exactly once', async () => {
    const off = vi.fn()
    const env = {
      task: { runIn: async () => ({ status: 'running' }) },
      watchRun: (_storeId: string, _runId: string, callback: (status: 'verified') => void) => {
        callback('verified')
        return off
      },
    } as unknown as OrchestrateEnv
    expect(await waitRunTerminal(env, 'store', 'run')).toBe('verified')
    expect(off).toHaveBeenCalledOnce()
  })
})

// Copy this file unchanged into a checkout at the baseline commit, then run only
// this test in each checkout with SINGULARITY_SCHEDULER_BENCH=1. The same seeded
// history exercises production functions; persistence, agents and clone costs
// are excluded, so these figures describe scheduler CPU work only.
test.runIf(process.env.SINGULARITY_SCHEDULER_BENCH === '1')(
  'production scheduler CPU benchmark',
  async () => {
    const { snapshot, memberTaskIds } = settledHistory(4_096, 512)
    const task = { snapshotIn: async () => snapshot } as unknown as TaskService
    const samples = 11
    const repetitions = 8
    const measure = async (work: () => unknown | Promise<unknown>): Promise<number> => {
      for (let index = 0; index < repetitions; index++) await work()
      const elapsed: number[] = []
      for (let sample = 0; sample < samples; sample++) {
        const start = performance.now()
        for (let index = 0; index < repetitions; index++) await work()
        elapsed.push((performance.now() - start) / repetitions)
      }
      return elapsed.sort((left, right) => left - right)[Math.floor(samples / 2)]!
    }
    const batchItemsMs = await measure(() => batchItems(memberTaskIds, snapshot.edges))
    const deriveOutcomesMs = await measure(() => deriveChildOutcomes(task, snapshot.id, 't-0', memberTaskIds))
    const latestRunsMs = await measure(() => memberTaskIds.map(taskId => latestRun(snapshot, taskId)))
    const result = JSON.stringify(
      {
        scope: 'production scheduler CPU; no persistence, clones, provider I/O or model calls',
        tasks: snapshot.tasks.length,
        runs: snapshot.runs.length,
        edges: snapshot.edges.length,
        batchMembers: memberTaskIds.length,
        samples,
        repetitions,
        medianMs: { batchItems: batchItemsMs, deriveChildOutcomes: deriveOutcomesMs, latestRuns: latestRunsMs },
      },
      null,
      2,
    )
    if (process.env.SINGULARITY_SCHEDULER_RESULT_FILE !== undefined) {
      await writeFile(process.env.SINGULARITY_SCHEDULER_RESULT_FILE, result + '\n')
    } else console.info(result)
  },
  30_000,
)
