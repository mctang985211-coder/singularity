import { describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { TaskInstance, TaskRun } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type {
  Config,
  RootBudgetExtensionHost,
  RootBudgetExtensionRequest,
  RootBudgetExtensionResult,
} from '../../src/index.ts'
import { TaskRuntime } from '../../src/index.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const ROOT_SESSION = 'root-session'
const STORE = rootTaskStoreId(ROOT_SESSION)
const ROOT_BUDGET: NonNullable<Config['rootBudget']> = { wallTimeMs: 3_600_000, maxRuns: 10 }

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

/**
 * The deployment these cases run in: one graph whose root session is
 * `ROOT_SESSION`, the real task store derived from it, and the root's own run
 * already started — the minimum an extension call needs to reach the approval
 * the deployment installed, built the way the budget-extension cases build it.
 *
 * Nothing here reads a private field of the runtime, and nothing here mocks the
 * entry under test. What each case fixes is what the outside sees: what the
 * registration entry answers, and which callback the extension path actually
 * puts its question to.
 */
function harness() {
  const sessions = new Map<string, StoredSession>()
  const persistence = {
    list: vi.fn(async () => [...sessions.values()].map(item => ({ header: item.header }))),
    create: vi.fn(async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
    open: vi.fn(async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
  }
  const graphs = {
    graphForSession: vi.fn(async () => ({
      id: 'g1',
      rootSessionId: ROOT_SESSION,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
    })),
  }
  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: () => {},
    emit: () => {},
    on: () => {},
    sessionPersistence: persistence,
    graphs,
  }
  const task = new TaskService(ctx as never)
  ctx.task = task
  const runtime = new TaskRuntime(ctx as never, { rootBudget: ROOT_BUDGET } as Config)
  return { task, runtime }
}

type Harness = ReturnType<typeof harness>

/** One installed approval that allows, with a reference of its own: the record then says which callback answered. */
function allowing(reference: string) {
  return vi.fn(async () => ({ kind: 'allowed' as const, reference }))
}

function rootTask(): TaskInstance {
  return {
    taskId: 'root',
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'ship the release',
    depth: 0,
    acceptanceCriteria: [],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }
}

function rootRun(): TaskRun {
  return {
    runId: 'r-root',
    taskId: 'root',
    sessionId: ROOT_SESSION,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
  }
}

/** A store holding the tree's root and its run — what an extension's reading is measured against. */
async function storeWithRoot(h: Harness): Promise<void> {
  await h.task.createStore(STORE)
  await h.task.createTaskIn(STORE, rootTask(), 'test')
  await h.task.admitTaskIn(STORE, 'root', 'test', { manifest: { capabilities: {}, missing: [], closure: 'closed' } })
  await h.task.startRunIn(STORE, rootRun(), 'test')
}

/**
 * One extension call through the public entry, under a host call identity of its
 * own. `maxRuns` is the whole approved total asked for: a request has to be a
 * raise of the reading in force to reach the question, so a case that extends
 * twice asks higher the second time.
 */
async function extend(h: Harness, requestKey: string, callId: string, maxRuns = 20): Promise<RootBudgetExtensionResult> {
  const host: RootBudgetExtensionHost = { callId, execution: { tool: 'task_budget_extend', call: callId } }
  const request: RootBudgetExtensionRequest = { requestKey, maxRuns }
  return await h.runtime.extendRootBudget(ROOT_SESSION, host, request)
}

/** The refusal one call got — or, when it was accepted, a message that says so instead of the expected text. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    const value = await call()
    throw new Error(`the call was accepted: ${JSON.stringify(value)}`)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The same for the synchronous registration entry: what it refused with, or a message saying it accepted the call. */
function registrationRefusal(call: () => unknown): string {
  try {
    const value = call()
    return `the registration was accepted and returned a ${typeof value}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('registerRootBudgetApproval', () => {
  test('refuses a second registration by name, leaving the approval already installed in force', async () => {
    const h = harness()
    await storeWithRoot(h)
    const installed = allowing('approval:first')
    h.runtime.registerRootBudgetApproval(installed)
    const intruder = allowing('approval:second')

    // The slot holds one approval for the deployment, so a second registration
    // is a refusal of its own — not a silent replacement, and not one of the
    // entry's other two answers (a non-function argument, no channel installed).
    const answer = registrationRefusal(() => h.runtime.registerRootBudgetApproval(intruder))
    expect(answer).toMatch(/root[- ]budget/i)
    expect(answer).toMatch(/already|existing|installed|second|replac|assembled once/i)
    expect(answer).not.toMatch(/must be a function/)
    expect(answer).not.toMatch(/no approval channel installed/)

    // And the refusal changed nothing: the extension is put to the callback
    // installed first, and the record carries that callback's reference.
    const result = await extend(h, 'k-after-second-registration', 'call-1')
    expect(intruder).not.toHaveBeenCalled()
    expect(installed).toHaveBeenCalledTimes(1)
    expect(result.answeredFromRecord).toBe(false)
    expect(result.record.approvalRef).toBe('approval:first')
  })

  test('takes a later registration once the approval it replaced was disposed, and asks the new one', async () => {
    const h = harness()
    await storeWithRoot(h)
    const first = allowing('approval:first')
    const disposeFirst = h.runtime.registerRootBudgetApproval(first)

    // The assembly's own dispose leaves the deployment with no approval at all:
    // a new request has nobody to ask and is refused by name.
    disposeFirst()
    expect(await refusal(() => extend(h, 'k-with-no-approval', 'call-1'))).toContain('no approval channel installed')

    // Which is what makes the next registration a first one, not a second: it
    // takes the slot, and it is the callback the extension path consults.
    const second = allowing('approval:second')
    const disposeSecond = h.runtime.registerRootBudgetApproval(second)
    expect(typeof disposeSecond).toBe('function')

    const result = await extend(h, 'k-reassembled', 'call-2')
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    expect(result.answeredFromRecord).toBe(false)
    expect(result.record.approvalRef).toBe('approval:second')
  })

  test('a disposer kept from an earlier registration cannot uninstall the approval that replaced it', async () => {
    const h = harness()
    await storeWithRoot(h)
    const first = allowing('approval:first')
    const disposeFirst = h.runtime.registerRootBudgetApproval(first)
    disposeFirst()
    const second = allowing('approval:second')
    const disposeSecond = h.runtime.registerRootBudgetApproval(second)

    // The stale disposer is called again, now that a later registration owns the
    // slot: it clears the registration it made and only that one.
    disposeFirst()

    const result = await extend(h, 'k-after-stale-dispose', 'call-1')
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    expect(result.answeredFromRecord).toBe(false)
    expect(result.record.approvalRef).toBe('approval:second')

    // The other half of the same ownership: the later registration's own disposer
    // still takes that one down, so the next raise has nobody to ask.
    disposeSecond()
    expect(await refusal(() => extend(h, 'k-after-new-dispose', 'call-2', 30))).toContain('no approval channel installed')
  })
})
