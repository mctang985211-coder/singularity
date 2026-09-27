import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Diagnosis, TaskEvent, TaskInstance, TaskRun } from '../../task/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { canonicalize } from '../../task/src/contract.ts'
import type { RootRecoveryRequest } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop } from '../support/scripted-loop.ts'

/**
 * A6 ownership at the service entry (plan §F.4, ticket EVO-5): the runtime's own
 * door — `TaskRuntime.recoverRootTask` — re-checks that the asking session's own
 * graph is the graph whose store it asks for. The tool and evolution doors keep
 * their own rules, and neither substitutes for this one: a caller that reaches
 * the service directly must meet the service's rule itself.
 *
 * The deployment is the real one (two graphs, each with its own root session and
 * its own store; the real `TaskService`/`TaskRuntime`, the real workspace
 * registry and the real durable log) with the model as the only stand-in. These
 * cases never need a model turn: they assert one named refusal and the store it
 * left exactly as it was.
 */

const GRAPH_A = 's-graph-a'
const GRAPH_B = 's-graph-b'
const STORE_A = rootTaskStoreId(GRAPH_A)
const NOW = '2026-09-28T00:00:00.000Z'
const MANIFEST = { capabilities: {}, missing: [], closure: 'closed' as const }

afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
})

/** The store's own durable task-event log, as the fixture's session surface holds it. */
function taskEvents(h: ScriptedLoop, storeId: string): TaskEvent[] {
  return h.eventsOf(storeId).flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** Everything under one directory (recursively), or nothing when it was never created. */
function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true }).map(String).sort()
  } catch {
    return []
  }
}

/** The run-binding root this deployment writes run snapshots and workspace markers under. */
function bindingRoot(h: ScriptedLoop): string {
  return join(h.home, 'singularity', 'run-bindings')
}

/** The refusal one call gets — or a thrown error saying it was accepted instead. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    const value = await call()
    throw new Error(`the call was accepted: ${JSON.stringify(value)}`)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The root contract both stores are seeded with: one command criterion and the map position 1 rests on. */
function rootTask(): TaskInstance {
  const acceptanceCriteria = [
    { criterionId: 'root-goal', description: 'the goal is delivered', verificationMode: 'deterministic' as const, requiredEvidence: [], mandatory: true, command: 'true' },
    {
      criterionId: 'root-map',
      description: 'the members the map names passed',
      verificationMode: 'composite' as const,
      requiredEvidence: [],
      mandatory: true,
      childEvidence: [{ childIndex: 0, criterionId: 'child-0' }, { childIndex: 1, criterionId: 'child-1' }],
    },
  ]
  return {
    taskId: 'root',
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'ship the release',
    depth: 0,
    acceptanceCriteria,
    requestedCapabilities: [],
    decompositionStatus: 'decomposable',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract: {
      contractVersion: 1,
      objective: 'ship the release',
      acceptanceCriteria: acceptanceCriteria as never,
      assumptions: [],
      constraints: [],
      requiredCapabilities: [],
    },
  }
}

/** The failed first attempt graph A's store holds — the state a recovery is asked for. */
function firstRun(): TaskRun {
  return {
    runId: 'r-first',
    taskId: 'root',
    sessionId: GRAPH_A,
    capabilitySnapshot: [],
    executionPhase: 'active',
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
  }
}

function diagnosis(): Diagnosis {
  return {
    diagnosisId: 'd-1',
    taskId: 'root',
    observedFailure: 'the second member never verified',
    scope: 'the root goal of this store',
    localizedCause: 'the capability the second member needed was missing',
    evidenceRefs: ['e-x'],
    reviewRefs: [],
    confidence: 'high',
    proposals: [],
  }
}

function request(overrides: Partial<RootRecoveryRequest> = {}): RootRecoveryRequest {
  return { sourceTaskId: 'root', sourceRunId: 'r-first', sourceDiagnosisId: 'd-1', requestKey: 'k-1', ...overrides }
}

/** Seed graph A's store with the failed root a recovery names, through the real store entries. */
async function storeWithFailedRoot(h: ScriptedLoop): Promise<void> {
  await h.task.createStore(STORE_A)
  await h.task.createTaskIn(STORE_A, rootTask(), 'test')
  await h.task.admitTaskIn(STORE_A, 'root', 'test', { manifest: MANIFEST })
  await h.task.startRunIn(STORE_A, firstRun(), 'test')
  await h.task.markRunStatusIn(STORE_A, 'root', 'r-first', 'failed', 'test', { reason: 'the second member never verified' })
  await h.task.recordDiagnosisIn(STORE_A, diagnosis(), 'test')
}

describe('A6 recovery ownership: the service entry checks the caller itself', () => {
  it('refuses graph B\'s live session asking for graph A\'s store, leaving nothing behind', async () => {
    const h = await startScriptedLoop({ roots: [GRAPH_A, GRAPH_B], script: () => [] })
    await storeWithFailedRoot(h)
    // Both roots are live sessions of the real loop; the caller below is graph B's.
    expect(h.agent(GRAPH_B)).toBeDefined()

    const before = canonicalize(await h.snapshot(STORE_A))
    const eventsBefore = taskEvents(h, STORE_A)
    const spawnsBefore = h.spawns.length
    const filesBefore = filesUnder(bindingRoot(h))

    const message = await refusal(() => h.runtime.recoverRootTask(STORE_A, request(), { sessionId: GRAPH_B }))
    // The refusal names the caller, the root session its graph answers with, the
    // store that root owns, and this store.
    expect(message).toContain(`session "${GRAPH_B}"`)
    expect(message).toContain(`root session is "${GRAPH_B}"`)
    expect(message).toContain(`"${rootTaskStoreId(GRAPH_B)}"`)
    expect(message).toContain(`"${STORE_A}"`)
    expect(message).toContain('nothing was written')

    // Zero new Run, zero new batch, zero writes: the store's own snapshot and its
    // own log are unchanged, nothing was spawned, and neither a run binding nor a
    // workspace claim (its marker under the run-binding root) was materialized.
    expect(canonicalize(await h.snapshot(STORE_A))).toBe(before)
    expect(taskEvents(h, STORE_A)).toEqual(eventsBefore)
    expect((await h.snapshot(STORE_A)).runs.filter(run => run.taskId === 'root')).toHaveLength(1)
    expect(h.spawns.length).toBe(spawnsBefore)
    expect(filesUnder(bindingRoot(h))).toEqual(filesBefore)
  })

  it('serves the store\'s own graph — the positive control', async () => {
    const h = await startScriptedLoop({ roots: [GRAPH_A, GRAPH_B], script: () => [] })
    await storeWithFailedRoot(h)
    const spawnsBefore = h.spawns.length

    // The same call from graph A's own live root session is not refused by the
    // ownership rule: it reaches the store's own next rule (a task this store
    // does not hold), which is how "the rule refuses the stranger, not every
    // caller" is read without a second walk through the whole attempt here.
    const message = await refusal(() => h.runtime.recoverRootTask(STORE_A, request({ sourceTaskId: 'no-such-task' }), { sessionId: GRAPH_A }))
    expect(message).toContain('holds no task "no-such-task"')
    expect(message).not.toContain('cannot open a recovery')
    expect(h.spawns.length).toBe(spawnsBefore)
  })
})
