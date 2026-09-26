import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import type { RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry } from '../support/scripted-loop.ts'

/**
 * S4-E (Q3, rework): the execution binding a replayed run is placed under, read
 * from the real loop.
 *
 * An experiment freezes its model selection and its wall clock *before* it runs
 * either side, and the frozen values have to reach the worker that really runs —
 * a spawn request field nobody consumes, or a report that restates the frozen
 * string, would prove neither. So every assertion here is read from what the
 * real `AgentLoop` actually did:
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
 * 3. **The per-run deadline ends work in flight.** A run placed under a wall
 *    clock that runs out cancels the worker's own turn (its session log records
 *    the abort), settles the run `failed` and records the stop as the budget
 *    exhaustion it is — named as the deadline this run was under, not as a
 *    criteria failure.
 *
 * The model's answers are the only scripted thing here; the store, the runtime,
 * the real `AgentRuntime.spawn`, the prompt assembly and the verifier are the
 * deployment's own.
 *
 * What is *not* covered here, and where it is covered instead: the sub-execution
 * sharing the parent's *window* is behavioural and racy to time at this level
 * (the parent's own bound expires at the same instant), so it is pinned by
 * `task-runtime/tests/unit/orchestrate.spec.ts` ("a child of a replayed worker
 * runs on the parent's remaining window") and by the pure `runDeadlineMs` cases.
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

  it('cancels the worker in flight when the run\u2019s own deadline passes, and records it as a budget stop', async () => {
    const h = await startScriptedLoop({
      providers: [DEPLOYMENT_DEFAULT.provider],
      // The worker never finishes on its own: only the run's own wall clock ends it.
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0 ? [{ text: 'root: the tree is active' }] : [{ hang: true }],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const champion = await writeChampion(h, root.storeId, championCriterion('true'))

    const outcome = await h.runtime.replayTask(root.storeId, champion.taskId, {
      lineage: `${LINEAGE}:deadline`,
      wallTimeMs: 800,
    }, ROOT)

    expect(outcome.status).toBe('failed')
    const worker = workerSession(h, 0)
    const run = await h.task.runIn(root.storeId, outcome.runId)
    const deadlineAt = new Date(Date.parse(run.startedAt) + 800).toISOString()
    expect(run.status).toBe('failed')
    const record = (await h.snapshot(root.storeId)).reviews.find(item => item.runId === outcome.runId)!
    expect(record.outcome).toBe('failed')
    // The stop is named as the budget exhaustion it is, and names the deadline this
    // run was under — the caller's own wall clock, anchored at the run's start.
    expect(record.localizedCause).toContain('budget exhausted: wallTimeMs')
    expect(record.localizedCause).toContain(deadlineAt)
    // And the deadline reached the worker's own loop: its session log records the
    // turn ending under the parent's cancel cause (`awaitWorker`'s forced exit).
    const turnEnds = h.eventsOf(worker).filter(event => event.type === 'turn/end')
    expect(turnEnds.length).toBeGreaterThan(0)
    expect(turnEnds[turnEnds.length - 1]!.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'parent' } } })
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
})
