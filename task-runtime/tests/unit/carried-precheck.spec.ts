import { afterEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import { requestedSession } from '../support/person-request.ts'
import type { BatchContext, Config, RootContractSpec } from '../../src/index.ts'
import { TaskRuntime } from '../../src/index.ts'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'

/**
 * The one pass-through S1-C leaves behind (guide §2.3 item 3, plan S1-C item 4):
 * the pre-check a batch passed travels *with the batch*, so every child's run
 * binding records the verdicts and the registry revision that were actually
 * judged instead of re-running discovery and hoping it sees the same bytes.
 *
 * Where it travels changed with A3 and the assertion changed with it: admission
 * hands the verdicts to the batch driver (`BatchContext.providers`) rather than
 * to a list of pre-built plans, because the driver re-reads its children from the
 * store on every round. The seam is asserted where it is observable — this file
 * captures the batch context the runtime starts its driver with, keeping the rest
 * of the orchestrator real through `importOriginal`, so admission's store writes
 * are exactly what the other specs exercise. What is being tested is that the
 * value each run's binding consumes is on the batch, computed once.
 */

const captured = vi.hoisted(() => ({ batches: [] as BatchContext[] }))

vi.mock('../../src/orchestration/batch.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/orchestration/batch.ts')>()
  return {
    ...actual,
    driveBatch: async (_env: unknown, batch: BatchContext) => {
      captured.batches.push(batch)
      // The driver is the thing under test elsewhere; here the batch has only to
      // be captured, so the settlement it would have produced is reported.
      return batch === undefined ? [] : []
    },
  }
})

const ROOT_SESSION = 'root-session'
const STORE = rootTaskStoreId(ROOT_SESSION)

afterEach(releaseSkillHomes)

/** The smallest context the admission path needs: a session store, a graph, and a root agent. */
function harness() {
  const sessions = new Map<string, { header: SessionHeader; events: SessionEvent[] }>()
  // The person's request, on the root session's own durable log: what a root
  // contract's origin is read from (A0 §1.10). The rule is the *existence* of a
  // user-sourced message, so one text stands for the request this harness's
  // intake rests on.
  sessions.set(ROOT_SESSION, requestedSession(ROOT_SESSION, 'ship the release'))
  const handle = (id: SessionId) => ({
    read: async () => ({ events: sessions.get(id)?.events ?? [] }),
    append: async (records: readonly SessionEvent[]) => {
      sessions.get(id)?.events.push(...records)
    },
    flush: async () => {},
    close: async () => {},
  })
  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: () => {},
    emit: () => {},
    on: () => {},
    sessionPersistence: {
      list: async () => [...sessions.values()].map(item => ({ header: item.header })),
      create: async (header: SessionHeader) => {
        sessions.set(header.id, { header, events: [] })
        return handle(header.id)
      },
      open: async (id: SessionId) => handle(id),
    },
    agents: { get: (id: string) => ({ id }) },
    graphs: {
      graphForSession: async () => ({
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: ROOT_SESSION,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }),
    },
    agentRuntime: {
      spawn: async () => {
        throw new Error('the mocked driver must not spawn a worker')
      },
    },
  }
  const task = new TaskService(ctx as never)
  ctx.task = task
  const runtime = new TaskRuntime(
    ctx as never,
    {
      capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } },
    } as unknown as Config,
  )
  return { ctx, task, runtime, sessions }
}

/**
 * The root contract this case runs under (A0 §1.2): one goal, one criterion a
 * command settles. The pre-check travels with a *batch*, so the root is setup —
 * but it is setup through the real intake, and its acceptance is stated here
 * rather than assumed.
 */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-ship', description: 'the release is shipped', command: 'true' }],
}

describe('the pre-check a batch passed travels with its batch (S1-C)', () => {
  test('the batch carries the verdicts, roots and registry revision admission judged, once', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness()
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, ROOT_CONTRACT)
    if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
    const { taskId, runId } = activated

    const { batchId, childTaskIds } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        {
          objective: 'design the ball',
          acceptanceCriteria: [{ description: 'works', command: 'true' }],
          requiredCapabilities: ['design-ball'],
        },
        { objective: 'and then some', acceptanceCriteria: [{ description: 'works', command: 'true' }] },
      ],
    })

    // The tool call returns at admission (A3 §3.1), and the driver this test
    // replaced is started asynchronously: waiting for the batch is what lets the
    // runtime reach it.
    await h.runtime.awaitBatch(STORE, batchId)
    expect(captured.batches).toHaveLength(1)
    const batch = captured.batches[0]!
    expect(batch.batchId).toBe(batchId)
    expect(childTaskIds).toHaveLength(2)
    const providers = batch.providers
    expect(providers).toBeDefined()
    expect(providers!.capabilities.map(row => row.capability)).toEqual(['design-ball'])
    expect(providers!.capabilities[0]!.skills.map(skill => (skill.valid ? skill.role : 'invalid'))).toEqual([
      'guidance',
    ])
    // The roots were the ones discovery actually walked, and the revision is the
    // value a run can cite later.
    expect(providers!.roots[0]).toBe(join(home, 'skills'))
    expect(providers!.revision).toMatch(/^[0-9a-f]{64}$/)

    // The children the store holds are the ones those rows were resolved for:
    // the manifest each run binds is the one admission judged, not a second
    // resolution — the row for the child that asked for it, and an empty
    // manifest for the sibling that asked for nothing.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.capabilities[childTaskIds[0]!]!.capabilities).toHaveProperty('design-ball')
    expect(Object.keys(snapshot.capabilities[childTaskIds[1]!]!.capabilities)).toEqual([])
  })
})
