/**
 * The driver's own gates, without a running graph: which graphs it takes over at
 * all, and what one pass does when there is nothing it may do. The end-to-end
 * behaviour is `tests/integration/coordination-driver.spec.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { GRAPH_PROTOCOL_V2 } from '@dangosys/dsh-singularity-graphs'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { CoordinationDriver, installCoordinationDriver } from '../../src/coordination/driver.ts'
import { graphImprovementCap } from '../../src/coordination/supervision.ts'

const ROOT = 's-root'
const STORE = `sg-t-${ROOT}`

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coordination-driver-unit-'))
  vi.stubEnv('SINGULARITY_COORDINATION_DIR', dir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const graph = (overrides: Record<string, unknown> = {}) => ({
  id: 'g1',
  name: 'graph one',
  envId: 'env1',
  rootSessionId: ROOT,
  graphStoreId: 'sg-g-root',
  layoutStoreId: 'sg-l-root',
  createdAt: 1,
  ready: true,
  protocol: { id: GRAPH_PROTOCOL_V2, version: 2, since: 1 },
  rsi: { task: 'improve the method', iterationRounds: 2, humanReview: false },
  ...overrides,
})

function snapshot(tasks: readonly unknown[], runs: readonly unknown[]): TaskSnapshot {
  return {
    tasks: tasks as never,
    runs: runs as never,
    reviews: [],
    diagnoses: [],
    evidence: [],
    obligations: [],
    capabilities: {},
  } as unknown as TaskSnapshot
}

function fake(input: {
  readonly graphs: readonly Record<string, unknown>[]
  readonly snapshot: TaskSnapshot
  readonly live?: readonly string[]
  readonly listed?: boolean
}): { readonly ctx: Context; readonly terminalListeners: ((fact: unknown) => void)[]; readonly spawns: string[] } {
  const terminalListeners: ((fact: unknown) => void)[] = []
  const spawns: string[] = []
  const ctx = {
    graphs: {
      list: async () => (input.listed === false ? [] : input.graphs),
      get: async (id: string) => {
        const found = input.graphs.find(item => item.id === id)
        if (found === undefined) throw new Error(`graphs: no graph "${id}"`)
        return found
      },
      graphForSession: async () => input.graphs[0],
    },
    task: { snapshotIn: async () => input.snapshot },
    taskRuntime: {
      registerTerminalReviewListener: (listener: (fact: unknown) => void) => {
        terminalListeners.push(listener)
        return () => undefined
      },
      receiptsOfStore: async () => [],
    },
    agents: { get: (id: string) => ((input.live ?? []).includes(id) ? { id, status: 'idle' } : undefined) },
    agentRuntime: {
      spawn: async (_parent: unknown, request: { sessionId: string }) => {
        spawns.push(request.sessionId)
        return { agent: { id: request.sessionId } }
      },
      resumeCoordinationSession: async (request: { sessionId: string }) => ({ agent: { id: request.sessionId } }),
    },
    get(name: string) {
      return (ctx as unknown as Record<string, unknown>)[name]
    },
    on: () => () => undefined,
  } as unknown as Context
  return { ctx, terminalListeners, spawns }
}

const settledRoot = snapshot(
  [{ taskId: 't-root', parentTaskId: undefined }],
  [{ runId: 'r-1', taskId: 't-root', status: 'verified', startedAt: '2026-10-08T00:00:00.000Z' }],
)

describe('which graphs the driver takes over', () => {
  test('a graph with no protocol marker is never scheduled, and its store is never read', async () => {
    const { ctx } = fake({ graphs: [graph({ protocol: undefined })], snapshot: settledRoot })
    const snapshotIn = vi.spyOn(ctx.task, 'snapshotIn')
    const driver = new CoordinationDriver(ctx, { log: () => {} })
    await driver.seed()
    expect(snapshotIn).not.toHaveBeenCalled()
    expect(graphImprovementCap(STORE)).toBeUndefined()
    driver.stop()
  })

  test('a graph without RSI settings is not scheduled either', async () => {
    const { ctx } = fake({ graphs: [graph({ rsi: undefined })], snapshot: settledRoot })
    const snapshotIn = vi.spyOn(ctx.task, 'snapshotIn')
    const driver = new CoordinationDriver(ctx, { log: () => {} })
    await driver.seed()
    expect(snapshotIn).not.toHaveBeenCalled()
    driver.stop()
  })

  test('a current graph with settings declares its round cap, and loses it when it is forgotten', async () => {
    const { ctx } = fake({ graphs: [graph()], snapshot: settledRoot, live: [ROOT] })
    const driver = new CoordinationDriver(ctx, { log: () => {} })
    await driver.seed()
    expect(graphImprovementCap(STORE)).toBe(2)
    driver.stop()
    expect(graphImprovementCap(STORE)).toBeUndefined()
  })
})

describe('one pass', () => {
  test('a store with no root task yet is idle and writes nothing', async () => {
    const { ctx } = fake({ graphs: [graph()], snapshot: snapshot([], []), live: [ROOT] })
    const driver = new CoordinationDriver(ctx, { log: () => {} })
    const step = await driver.wake('g1')
    expect(step).toMatchObject({ kind: 'idle' })
    expect(await driver.workOf('g1')).toEqual([])
    driver.stop()
  })

  test('a settled round is spawned for, with the assignment on the file before the spawn', async () => {
    const { ctx, spawns } = fake({ graphs: [graph()], snapshot: settledRoot, live: [ROOT] })
    const driver = new CoordinationDriver(ctx, { log: () => {} })
    expect(await driver.wake('g1')).toMatchObject({ kind: 'supervise', plan: { kind: 'assign' } })
    const work = await driver.workOf('g1')
    expect(work).toHaveLength(1)
    expect(spawns).toEqual([work[0]!.assignment.sessionId])
    expect(work[0]!.assignment).toMatchObject({ graphId: 'g1', storeId: STORE, role: 'supervisor' })
    driver.stop()
  })

  test('without a live root nothing is spawned and no row is written', async () => {
    const { ctx, spawns } = fake({ graphs: [graph()], snapshot: settledRoot })
    const driver = new CoordinationDriver(ctx, { log: () => {} })
    await driver.wake('g1')
    expect(spawns).toEqual([])
    expect(await driver.workOf('g1')).toEqual([])
    driver.stop()
  })
})

describe('installation', () => {
  test('a driver that cannot be installed on a missing registry answers without throwing', async () => {
    const { ctx } = fake({ graphs: [], snapshot: settledRoot, listed: false })
    const installed = installCoordinationDriver(ctx, { log: () => {}, fallbackMs: 5 })
    await installed.driver.seed()
    expect(await installed.driver.workOf('g1')).toEqual([])
    installed.dispose()
  })
})
