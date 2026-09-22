import { afterEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { ChildPlan, Config } from '../../src/index.ts'
import { TaskRuntime } from '../../src/index.ts'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'

/**
 * The one pass-through S1-C leaves behind (guide §2.3 item 3, plan S1-C item 4):
 * the pre-check a batch passed travels with every plan the cascade runs, so the
 * Run binding records the verdicts and the registry revision that were actually
 * judged instead of re-running discovery and hoping it sees the same bytes.
 * That consumer now exists (`run-binding.ts`, exercised end to end in
 * `orchestrate.spec.ts`); this file keeps the seam itself honest.
 *
 * The seam is asserted where it is observable: this file captures the plans
 * `decomposeAndRun` hands the cascade — with the rest of the orchestrator kept
 * real through `importOriginal`, which keeps the store writes and admission
 * exactly what the other specs exercise. `runChildrenCascade` itself is replaced
 * here so the plans can be read without a cascade running; what is being tested
 * is that the value the binding consumes is on every plan.
 */

const captured = vi.hoisted(() => ({ plans: [] as readonly unknown[] }))

vi.mock('../../src/orchestrate.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/orchestrate.ts')>()
  return {
    ...actual,
    runChildrenCascade: async (
      _env: unknown,
      _storeId: string,
      _parentTask: unknown,
      _parentRun: unknown,
      plans: readonly ChildPlan[],
    ) => {
      captured.plans = [...plans]
      return plans.map(plan => ({ taskId: plan.task.taskId, status: 'verified' as const }))
    },
  }
})

const ROOT_SESSION = 'root-session'
const STORE = rootTaskStoreId(ROOT_SESSION)

afterEach(releaseSkillHomes)

/** The smallest context the admission path needs: a session store, a graph, and a root agent. */
function harness() {
  const sessions = new Map<string, { header: SessionHeader; events: SessionEvent[] }>()
  const handle = (id: SessionId) => ({
    read: async () => ({ events: sessions.get(id)?.events ?? [] }),
    append: async (records: readonly SessionEvent[]) => { sessions.get(id)?.events.push(...records) },
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
      spawn: async () => { throw new Error('the mocked cascade must not spawn a worker') },
    },
  }
  const task = new TaskService(ctx as never)
  ctx.task = task
  const runtime = new TaskRuntime(ctx as never, {
    capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } },
  } as unknown as Config)
  return { ctx, task, runtime }
}

describe('the pre-check a batch passed travels with its plans (S1-C)', () => {
  test('every plan carries the same verdicts, roots and registry revision the batch was admitted under', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness()
    const { taskId, runId } = await h.runtime.createRootTask(
      STORE,
      { objective: 'ship the release', rootSessionId: ROOT_SESSION },
      ROOT_SESSION,
    )

    const outcomes = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        { objective: 'design the ball', acceptanceCriteria: [{ description: 'works', command: 'true' }], requiredCapabilities: ['design-ball'] },
        { objective: 'and then some', acceptanceCriteria: [{ description: 'works', command: 'true' }] },
      ],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect(captured.plans).toHaveLength(2)

    // One pre-check for the batch: both plans cite the same value, computed once
    // from the manifest's matched rows — not once per child.
    const first = (captured.plans[0] as ChildPlan).providers
    const second = (captured.plans[1] as ChildPlan).providers
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(first!.capabilities.map(row => row.capability)).toEqual(['design-ball'])
    expect(first!.capabilities[0]!.skills.map(skill => (skill.valid ? skill.role : 'invalid'))).toEqual(['guidance'])
    // The roots were the ones discovery actually walked, and the revision is the
    // value a run can cite later.
    expect(first!.roots[0]).toBe(join(home, 'skills'))
    expect(first!.revision).toMatch(/^[0-9a-f]{64}$/)
  })
})
