import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import type { RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry } from '../support/scripted-loop.ts'

/**
 * S4-E (Q3, rework): the execution binding a replayed run is placed under, read
 * from the real loop.
 *
 * An experiment freezes its model selection *before* it runs either side, and
 * the frozen value has to reach the worker that really runs — a spawn request
 * field nobody consumes, or a report that restates the frozen string, would
 * prove neither. So every assertion here is read from what the real `AgentLoop`
 * actually did:
 *
 * 1. **The identity is the route, not the request field.** The scripted adapter
 *    records every request with the provider and model the loop routed it to
 *    (`GenerateOptions.provider`/`model`), and the loop's own declared route is
 *    the registry's `agent.options`. A replay that names `agentOptions` must
 *    produce requests on that route; one that names none must keep the
 *    deployment's default, byte for byte.
 * 2. **The sub-execution is not a second experiment.** A replayed worker that
 *    decomposes gets children adjudicated under the *same* frozen selection —
 *    asserted on the child's own recorded requests, because that is where the
 *    child's identity is real.
 *
 * The model's answers are the only scripted thing here; the store, the runtime,
 * the real `AgentRuntime.spawn`, the prompt assembly and the verifier are the
 * deployment's own.
 *
 * An experiment places no clock of its own: the run's time is the runtime's own
 * limits (`Config.budget.wallTimeMs`, the root budget), pinned by
 * `task-runtime/tests/unit/orchestrate.spec.ts` and the pure `runDeadlineMs`
 * cases in `task-runtime/tests/unit/root-budget.spec.ts`. A caller that still
 * names the deleted `wallTimeMs` option is refused by name at the entry, before
 * a Run, a spawn or any other write exists.
 */

const ROOT = 's-root' as SessionId
/** The lineage tag every experiment carries; a replay task's objective is prefixed with it. */
const LINEAGE = 'evolution-replay:execution-binding'
/** The selection one side of the experiment was frozen under — a route of its own, so nothing else can answer for it. */
const FROZEN = { provider: 'frozen', model: 'frozen-model' } as const
/** The deployment default this fixture installs, which a replay must keep when it freezes nothing. */
const DEPLOYMENT_DEFAULT = { provider: 'mock', model: 'mock' } as const

/** The root contract every case runs under: one goal, one criterion a command settles. */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

afterEach(async () => {
  await disposeScriptedLoops()
})

/** One command-settled criterion a champion's replay can be judged by. */
function championCriterion(command: string): AcceptanceCriterion {
  return { criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command }
}

/**
 * Write one terminal champion task straight into the store — the record a replay
 * descends from — through the store's own service, so a replay's subject is the
 * historical shape rather than a fixture invention.
 */
async function writeChampion(h: ScriptedLoop, storeId: string, criterion: AcceptanceCriterion): Promise<{ taskId: string; runId: string }> {
  const taskId = 't-champion'
  const runId = 'r-champion'
  await h.task.createTaskIn(storeId, {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'champion work',
    depth: 0,
    acceptanceCriteria: [criterion],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(storeId, taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(storeId, {
    runId,
    taskId,
    sessionId: 's-champion',
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, taskId, runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(storeId, {
    evidenceId: `e-${runId}`,
    taskRunId: runId,
    taskId,
    artifacts: [],
    verifierResults: [{ criterionId: criterion.criterionId, status: 'pass', verifierId: 'fake-verifier' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, taskId, runId, 'verified', 'tester')
  return { taskId, runId }
}

/** The routes one session's loop actually sent its requests to, in request order. */
function routes(h: ScriptedLoop, sessionId: string): Array<{ provider: string; model: string }> {
  return h.requestsOf(sessionId).map(request => ({ provider: request.options.provider, model: request.options.model }))
}

/** The worker the runtime spawned for a replay, in spawn order. */
function workerSession(h: ScriptedLoop, index = 0): string {
  const spawn = h.spawns[index]
  if (spawn === undefined) throw new Error(`no spawn ${index} was recorded`)
  return spawn.sessionId
}

describe('S4-E: the execution binding of a replayed run (real loop)', () => {
  it('routes the replayed worker\u2019s own requests to the frozen selection, and to the deployment default when none is named', async () => {
    const h = await startScriptedLoop({
      providers: [DEPLOYMENT_DEFAULT.provider, FROZEN.provider],
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [{ text: 'root: the tree is active' }]
        : [
          { tool: 'task_submit_result', args: { summary: 'the replayed work is done' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const champion = await writeChampion(h, root.storeId, championCriterion('true'))

    const frozen = await h.runtime.replayTask(root.storeId, champion.taskId, {
      lineage: `${LINEAGE}:frozen`,
      agentOptions: { ...FROZEN },
    }, ROOT)
    expect(frozen.status).toBe('verified')

    const worker = workerSession(h, 0)
    // The deepest surface there is: the route the loop actually sent each request
    // to, as the adapter that received it recorded. A binding that only reached a
    // request field nobody consumed would leave these on the deployment default.
    const sent = routes(h, worker)
    expect(sent.length).toBeGreaterThan(0)
    expect(new Set(sent.map(route => `${route.provider}/${route.model}`))).toEqual(new Set([`${FROZEN.provider}/${FROZEN.model}`]))
    // And the loop's own declared route is the frozen one, not a per-request patch.
    expect(h.agent(worker).options).toMatchObject({ provider: FROZEN.provider, model: FROZEN.model })

    // The binding belongs to the run that named it: the next replay of the same
    // champion, without it, runs on the deployment's default exactly as before.
    const plain = await h.runtime.replayTask(root.storeId, champion.taskId, { lineage: `${LINEAGE}:default` }, ROOT)
    expect(plain.status).toBe('verified')
    const plainWorker = workerSession(h, 1)
    const plainSent = routes(h, plainWorker)
    expect(plainSent.length).toBeGreaterThan(0)
    expect(new Set(plainSent.map(route => `${route.provider}/${route.model}`)))
      .toEqual(new Set([`${DEPLOYMENT_DEFAULT.provider}/${DEPLOYMENT_DEFAULT.model}`]))
    expect(h.agent(plainWorker).options).toMatchObject({ provider: DEPLOYMENT_DEFAULT.provider, model: DEPLOYMENT_DEFAULT.model })
  })

  it('runs the sub-execution a replayed worker decomposes into under the same frozen selection', async () => {
    const h = await startScriptedLoop({
      providers: [DEPLOYMENT_DEFAULT.provider, FROZEN.provider],
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [{ text: 'root: the tree is active' }]
        : index === 1
          ? [
            {
              tool: 'task_decompose',
              args: {
                reason: 'the replayed work turned out not to be atomic',
                children: [{ objective: 'the child of the replayed work', acceptanceCriteria: [{ description: 'the child holds', command: 'true' }] }],
              },
            },
            { text: 'worker: the batch is the runtime\u2019s now' },
            // The batch end wakes this worker's own next turn (K1 §2): with the
            // child judged, the sub-execution's worker hands its result in, and
            // only that submission starts the replayed run's acceptance.
            { tool: 'task_submit_result', args: { summary: 'the child is done and the sub-execution holds' } },
            { text: 'worker: handed in' },
          ]
          : [
            { tool: 'task_submit_result', args: { summary: 'the child is done' } },
            { text: 'child: handed in' },
          ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const champion = await writeChampion(h, root.storeId, championCriterion('true'))

    const outcome = await h.runtime.replayTask(root.storeId, champion.taskId, {
      lineage: LINEAGE,
      agentOptions: { ...FROZEN },
    }, ROOT)

    expect(outcome.status).toBe('verified')
    // The worker split, the child ran to a verdict, and the parent accepted it: the
    // subtree is the run, so the sub-execution is where the binding has to hold too.
    const worker = workerSession(h, 0)
    const child = workerSession(h, 1)
    expect((await h.runForSession(child)).run.status).toBe('verified')
    for (const sessionId of [worker, child]) {
      const sent = routes(h, sessionId)
      expect(sent.length).toBeGreaterThan(0)
      expect(new Set(sent.map(route => `${route.provider}/${route.model}`)))
        .toEqual(new Set([`${FROZEN.provider}/${FROZEN.model}`]))
    }
  })

  it('keeps a run with no deadline in flight until its worker submits, exactly as before', async () => {
    const release = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      providers: [DEPLOYMENT_DEFAULT.provider],
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [{ text: 'root: the tree is active' }]
        : [
          { waitFor: () => release.promise },
          { tool: 'task_submit_result', args: { summary: 'the replayed work is done' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const champion = await writeChampion(h, root.storeId, championCriterion('true'))

    const replaying = h.runtime.replayTask(root.storeId, champion.taskId, { lineage: `${LINEAGE}:no-deadline` }, ROOT)
    // The worker is in flight — its first request is served only once this test
    // releases it — and nothing about the run has moved while it was parked.
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
    const worker = workerSession(h, 0)
    await vi.waitFor(() => expect(h.requestsOf(worker).length).toBeGreaterThan(0))
    expect((await h.runForSession(worker)).run.status).toBe('running')
    release.resolve()
    expect((await replaying).status).toBe('verified')
  })

  it('refuses the removed wallTimeMs option by name, before any Run exists', async () => {
    const h = await startScriptedLoop({
      providers: ['mock'],
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [{ text: 'root: the tree is active' }]
        : [
          { tool: 'task_submit_result', args: { summary: 'the replayed work is done' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const champion = await writeChampion(h, root.storeId, championCriterion('true'))
    const before = await h.snapshot(root.storeId)

    // The clock this build deleted is refused at the entry, before a task, a run
    // or a spawn exists: nothing may stand in for a deadline nobody keeps.
    const err = await h.runtime
      .replayTask(root.storeId, champion.taskId, { lineage: `${LINEAGE}:removed-clock`, wallTimeMs: 1 } as never, ROOT)
      .then(() => undefined, (error: unknown) => error)

    expect.soft(err, 'old option must not be silently ignored').toBeInstanceOf(Error)
    expect.soft(err instanceof Error ? err.message : '', 'the refusal names the removed option').toContain('wallTimeMs')
    expect.soft(h.spawns).toHaveLength(0)
    expect.soft((await h.snapshot(root.storeId)).runs).toHaveLength(before.runs.length)
  })
})
