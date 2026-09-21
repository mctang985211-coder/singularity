import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion, EvidenceBundle, TaskEvent, TaskInstance, TaskRun } from '../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'

/**
 * P4 end to end on the real chain: the real `TaskService` store and reducer,
 * the real `TaskRuntime` cascade, and the real `VerifierRegistry` with its real
 * `CommandVerifier` and `CompositeVerifier` — a parent's `childEvidence` map and
 * an independent parent-level combination command are judged by the code that
 * ships, and every verdict asserted here is read back out of the persisted
 * `task/event` log rather than off the writer's return value.
 *
 * What is stubbed, and why: `sessionPersistence` (a memory handle), `agentRuntime`
 * (no model loop runs in this test), and the `agents` lookup (a spawned worker's
 * agent). Nothing about verification is stubbed.
 */

const ROOT_SESSION = 's-root'
const STORE = rootTaskStoreId(ROOT_SESSION)

interface Harness {
  task: TaskService
  runtime: TaskRuntime
  verifier: VerifierRegistry
  log: Map<string, SessionEvent[]>
  spawned: string[]
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  const log = new Map<string, SessionEvent[]>()
  const headers = new Map<string, SessionHeader>()
  ctx.provide('sessionPersistence', {
    list: async () => [...headers.values()].map(header => ({ header })),
    create: async (header: SessionHeader) => {
      headers.set(header.id, header)
      log.set(header.id, [])
      return {
        read: async () => ({ events: log.get(header.id) ?? [] }),
        append: async (records: readonly SessionEvent[]) => { log.get(header.id)?.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
    open: async (id: SessionId) => {
      const stored = log.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored }),
        append: async (records: readonly SessionEvent[]) => { stored.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
  } as never)

  const spawned: string[] = []
  ctx.provide('agentRuntime', {
    spawn: async (_parent: unknown, request: { sessionId: string }) => {
      spawned.push(request.sessionId)
      return {
        agent: { id: request.sessionId, cancel: () => {}, whenIdle: async () => {} },
        dispose: async () => {},
      }
    },
  } as never)
  ctx.provide('agents', { get: (sessionId: string) => ({ id: sessionId }) } as never)
  ctx.provide('graphs', {
    graphForSession: async () => ({ id: 'g1', envId: 'env1', rootSessionId: ROOT_SESSION }),
  } as never)

  const task = new TaskService(ctx)
  const verifier = new VerifierRegistry(ctx, { evidenceRoot: await mkdtemp(join(tmpdir(), 'p4-evidence-')) })
  const runtime = new TaskRuntime(ctx)
  return { task, runtime, verifier, log, spawned }
}

/** Every task event the store actually appended, read back off its session log. */
function taskEvents(h: Harness): TaskEvent[] {
  return [...h.log.values()].flatMap(events => events.flatMap(event =>
    event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** The payload of one task's event of one kind, or undefined when it never landed. */
function payloadOf<K extends TaskEvent['kind']>(h: Harness, kind: K, taskId: string): Extract<TaskEvent, { kind: K }>['payload'] | undefined {
  const event = taskEvents(h).find(item => item.kind === kind && item.taskId === taskId) as Extract<TaskEvent, { kind: K }> | undefined
  return event?.payload
}

/** The evidence bundles persisted under one run. */
function evidenceFor(h: Harness, runId: string): EvidenceBundle[] {
  return taskEvents(h).flatMap(item => item.kind === 'EvidenceProduced' && item.runId === runId ? [item.payload.evidence] : [])
}

/**
 * A parent task authored directly in the store with caller-chosen acceptance
 * criteria — the shape a parent-level evidence map arrives on, since
 * `createRootTask` expands the fixed RootTaskSpec and a stored task's criteria
 * are immutable.
 */
async function createParent(h: Harness, acceptanceCriteria: AcceptanceCriterion[]): Promise<{ taskId: string; runId: string }> {
  await h.task.createStore(STORE)
  const taskId = 't-parent'
  const runId = 'r-parent'
  const task: TaskInstance = {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'prove the combination, not only the parts',
    depth: 0,
    acceptanceCriteria,
    requestedCapabilities: [],
    decompositionStatus: 'decomposable',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }
  await h.task.createTaskIn(STORE, task, 'tester')
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'decomposable' })
  const run: TaskRun = {
    runId,
    taskId,
    sessionId: ROOT_SESSION,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  await h.task.startRunIn(STORE, run, 'tester')
  return { taskId, runId }
}

/** One producer task whose run settled terminal with evidence carrying the artifact. */
async function seedProducer(h: Harness, outcome: 'verified' | 'failed', kind: string): Promise<void> {
  const taskId = `t-producer-${outcome}`
  const runId = `r-producer-${outcome}`
  const status = outcome === 'verified' ? 'pass' : 'fail'
  await h.task.createTaskIn(STORE, {
    taskId,
    definitionRef: { taskType: 'producer', version: 1 },
    objective: 'produce the reference product',
    depth: 0,
    acceptanceCriteria: [{
      criterionId: 'producer-1',
      description: 'the product exists',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, {
    runId, taskId, sessionId: 's-producer', capabilitySnapshot: [], artifacts: [], verifierResults: [], status: 'running', startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, taskId, runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(STORE, {
    evidenceId: `e-${runId}`,
    taskRunId: runId,
    taskId,
    artifacts: [{ artifactId: `a-${kind}`, kind, uri: `products/${kind}.jsonl` }],
    verifierResults: [{ criterionId: 'producer-1', status, verifierId: 'seeded' }],
    claims: [{ claimId: `claim-${kind}`, criterionId: 'producer-1', status, verifierId: 'seeded', artifactRefs: [] }],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, taskId, runId, outcome, 'tester',
    outcome === 'failed' ? { reason: 'the producer failed' } : {})
}

/** The interface fixture the parent-level combination command reads. */
async function seedInterface(aluResult: number, modelResult: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'p4-iface-'))
  const file = join(dir, 'iface.json')
  await writeFile(file, JSON.stringify({ alu: { result: aluResult }, model: { result: modelResult } }))
  return file
}

const interfaceCommand = (file: string) =>
  `node -e "const i=require('${file}');process.exit(i.alu.result===i.model.result?0:1)"`

/** A verified champion task for the replay-path tests. */
async function createVerifiedChampion(h: Harness): Promise<string> {
  const taskId = 't-champion'
  await h.task.createStore(STORE)
  await h.task.createTaskIn(STORE, {
    taskId,
    definitionRef: { taskType: 'subtask', version: 1 },
    objective: 'the champion task',
    depth: 0,
    acceptanceCriteria: [{
      criterionId: 'champion-1',
      description: 'the champion works',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, {
    runId: 'r-champion', taskId, sessionId: 's-champion', capabilitySnapshot: [], artifacts: [], verifierResults: [], status: 'running', startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, taskId, 'r-champion', 'verifying', 'tester')
  await h.task.recordEvidenceIn(STORE, {
    evidenceId: 'e-champion',
    taskRunId: 'r-champion',
    taskId,
    artifacts: [],
    verifierResults: [{ criterionId: 'champion-1', status: 'pass', verifierId: 'seeded' }],
    claims: [{ claimId: 'claim-champion', criterionId: 'champion-1', status: 'pass', verifierId: 'seeded', artifactRefs: [] }],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, taskId, 'r-champion', 'verified', 'tester')
  return taskId
}

describe('parent acceptance and evidence identity, end to end (P4)', () => {
  it.each([false, true])('parent mapping preserves child heuristic classification (heuristic=%s)', async heuristic => {
    const h = await harness()
    const { taskId, runId } = await createParent(h, [{
      criterionId: 'root-map', description: 'independent evidence', verificationMode: 'composite',
      mandatory: true, requiredEvidence: [], childEvidence: [{ childIndex: 0, criterionId: 'ac1-2' }],
    }])
    await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'check evidence classification',
      children: [{ objective: 'child', acceptanceCriteria: [
        { description: 'mechanical check', command: 'true' },
        { description: 'optional judgement', command: 'true', mandatory: false, heuristic },
      ] }],
    })
    expect((await h.task.childrenIn(STORE, taskId))[0]!.status).toBe('verified')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe(heuristic ? 'failed' : 'verified')
    if (heuristic) {
      expect(payloadOf(h, 'TaskFailed', taskId)?.reason).toContain('heuristic')
      expect(evidenceFor(h, runId)[0]!.verifierResults[0]!.details).toContain('ac1-2')
    }
  })

  it.each([
    { explicit: false, validMap: false, customPass: true },
    { explicit: true, validMap: false, customPass: true },
    { explicit: false, validMap: true, customPass: true },
    { explicit: true, validMap: true, customPass: true },
    { explicit: true, validMap: true, customPass: false },
  ])('custom verifier cannot bypass mapping or be bypassed: %j', async ({ explicit, validMap, customPass }) => {
    const h = await harness()
    let calls = 0
    h.verifier.register({
      id: 'custom-composite', supports: mode => mode === 'composite',
      verify: async req => {
        calls++
        return req.criteria.map(c => ({
          criterionId: c.criterionId, verifierId: 'custom-composite', status: customPass ? 'pass' : 'fail',
        }))
      },
    })
    const { taskId, runId } = await createParent(h, [{
      criterionId: 'root-map', description: 'required map', verificationMode: 'composite',
      mandatory: true, requiredEvidence: [],
      childEvidence: [{ childIndex: 0, criterionId: validMap ? 'ac1-1' : 'missing-criterion' }],
      ...(explicit ? { verifierRef: 'custom-composite' } : {}),
    }])
    await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'custom verifier',
      children: [{ objective: 'child', acceptanceCriteria: [{ description: 'works', command: 'true' }] }],
    })
    expect((await h.task.taskIn(STORE, taskId)).status).toBe(validMap && customPass ? 'verified' : 'failed')
    expect(calls).toBe(validMap ? 1 : 0)
    if (!validMap) expect(evidenceFor(h, runId)[0]!.verifierResults[0]!.details).toContain('missing-criterion')
  })

  for (const field of ['requiresArtifact', 'acceptsArtifact'] as const) {
    for (const spawn of [false, true]) {
      it.each(['missing', 'failed', 'verified'] as const)(`replay ${field}, spawn=${spawn}, producer=%s`, async producer => {
        const h = await harness()
        const championId = await createVerifiedChampion(h)
        if (producer !== 'missing') await seedProducer(h, producer, 'reference')
        const before = taskEvents(h).length
        const replay = h.runtime.replayTask(STORE, championId, {
          lineage: 'evolution-replay:p4-regression', spawn,
          contract: {
            objective: 'consume reference', requiredCapabilities: [],
            acceptanceCriteria: [{
              criterionId: 'consume', description: 'consume reference', verificationMode: 'deterministic',
              mandatory: true, requiredEvidence: [], command: 'true', [field]: ['reference'],
            }],
          },
        }, ROOT_SESSION)
        if (producer === 'missing' || (field === 'requiresArtifact' && producer === 'failed')) {
          await expect(replay).rejects.toThrow(/missing required artifacts: reference/)
          expect(h.spawned).toHaveLength(0)
          expect(taskEvents(h)).toHaveLength(before)
        } else {
          const result = await replay
          expect(result.status).toBe('verified')
          expect(h.spawned).toHaveLength(spawn ? 1 : 0)
          expect(evidenceFor(h, result.runId)[0]!.verifierResults[0]!.status).toBe('pass')
        }
      })
    }
  }

  it('P4-A: a complete childEvidence map plus a passing combination command verifies the parent', async () => {
    const h = await harness()
    const iface = await seedInterface(7, 7)
    const { taskId, runId } = await createParent(h, [
      {
        criterionId: 'root-map',
        description: 'the children together prove the root goal',
        verificationMode: 'composite',
        requiredEvidence: [],
        mandatory: true,
        childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }, { childIndex: 1, criterionId: 'ac2-1' }],
      },
      {
        criterionId: 'root-interface',
        description: 'the combined interface is numerically consistent',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: interfaceCommand(iface),
      },
    ])

    const outcomes = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        { objective: 'port the ALU', acceptanceCriteria: [{ description: 'the port compiles', command: 'true' }] },
        { objective: 'run the model', acceptanceCriteria: [{ description: 'the model runs', command: 'true' }] },
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('verified')

    // The persisted evidence shows both independent checks, by their real verifiers.
    const parentEvidence = evidenceFor(h, runId)
    expect(parentEvidence).toHaveLength(1)
    const byId = Object.fromEntries(parentEvidence[0]!.verifierResults.map(result => [result.criterionId, result]))
    expect(byId['root-map']).toMatchObject({ status: 'pass', verifierId: 'composite' })
    expect(byId['root-map']!.details).toContain('child #0')
    expect(byId['root-map']!.details).toContain('ac1-1')
    expect(byId['root-interface']).toMatchObject({ status: 'pass', verifierId: 'command', exitCode: 0 })
  })

  it('P4-D: children all verified but the combination command fails — the parent is refused', async () => {
    const h = await harness()
    const iface = await seedInterface(7, 8)
    const { taskId, runId } = await createParent(h, [
      {
        criterionId: 'root-map',
        description: 'the children together prove the root goal',
        verificationMode: 'composite',
        requiredEvidence: [],
        mandatory: true,
        childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }],
      },
      {
        criterionId: 'root-interface',
        description: 'the combined interface is numerically consistent',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: interfaceCommand(iface),
      },
    ])

    const outcomes = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        { objective: 'port the ALU', acceptanceCriteria: [{ description: 'the port compiles', command: 'true' }] },
        { objective: 'run the model', acceptanceCriteria: [{ description: 'the model runs', command: 'true' }] },
      ],
    })

    // The conjunction half passed; the independent parent-level check is what refused.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('failed')
    expect(payloadOf(h, 'TaskFailed', taskId)?.reason).toContain('root-interface')
    const parentEvidence = evidenceFor(h, runId)
    expect(parentEvidence[0]!.verifierResults.find(result => result.criterionId === 'root-interface'))
      .toMatchObject({ status: 'fail', verifierId: 'command', exitCode: 1 })
  })

  it('P4-B: a map pointing at a criterion no child has fails the parent, naming the missing item', async () => {
    const h = await harness()
    const { taskId, runId } = await createParent(h, [{
      criterionId: 'root-map',
      description: 'the children together prove the root goal',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
      childEvidence: [{ childIndex: 1, criterionId: 'ac2-9' }],
    }])

    const outcomes = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        { objective: 'port the ALU', acceptanceCriteria: [{ description: 'the port compiles', command: 'true' }] },
        { objective: 'run the model', acceptanceCriteria: [{ description: 'the model runs', command: 'true' }] },
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('failed')
    expect(payloadOf(h, 'TaskFailed', taskId)?.reason).toContain('ac2-9')
    const parentEvidence = evidenceFor(h, runId)
    expect(parentEvidence[0]!.verifierResults[0]!.details).toContain('ac2-9')
  })

  it('P4-C: a same-named product from a failed run does not satisfy requiresArtifact', async () => {
    const h = await harness()
    const { taskId: rootTaskId, runId: rootRunId } =
      await h.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT_SESSION }, ROOT_SESSION)
    await seedProducer(h, 'failed', 'bemu_trace')

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [{
        objective: 'rtl implementation',
        acceptanceCriteria: [{ description: 'cycle-equivalent to the reference', command: 'true', requiresArtifact: ['bemu_trace'] }],
      }],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['blocked'])
    expect(h.spawned).toHaveLength(0)
    expect(payloadOf(h, 'TaskBlocked', outcomes[0]!.taskId)?.reason)
      .toBe('missing required artifacts: bemu_trace (criterion ac1-1)')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]!.criterion).toContain('verified run')
    // The expired reference propagates: the root's own composite verdict refuses too.
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('failed')
  })

  it('P4-C: the verified run of the same producer satisfies the dependency', async () => {
    const h = await harness()
    const { taskId: rootTaskId, runId: rootRunId } =
      await h.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT_SESSION }, ROOT_SESSION)
    await seedProducer(h, 'verified', 'bemu_trace')

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [{
        objective: 'rtl implementation',
        acceptanceCriteria: [{ description: 'cycle-equivalent to the reference', command: 'true', requiresArtifact: ['bemu_trace'] }],
      }],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned).toHaveLength(1)
    expect((await h.task.snapshotIn(STORE)).obligations).toHaveLength(0)
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('verified')
  })

  it('replay shares the admission rule: a malformed childEvidence contract is rejected before anything persists', async () => {
    const h = await harness()
    const championId = await createVerifiedChampion(h)

    await expect(h.runtime.replayTask(STORE, championId, {
      lineage: 'evolution-replay:p4',
      contract: {
        objective: 'candidate contract',
        acceptanceCriteria: [{
          criterionId: 'cand-1',
          description: 'the candidate combination',
          verificationMode: 'composite',
          requiredEvidence: [],
          mandatory: true,
          childEvidence: [{ childIndex: -1 }],
        }],
        requiredCapabilities: [],
      },
    }, ROOT_SESSION)).rejects.toThrow(/childEvidence/)

    // Nothing persisted: the replay never created its task.
    expect((await h.task.snapshotIn(STORE)).tasks.map(item => item.taskId)).toEqual([championId])
  })

  it('replay shares the acceptance rule: a well-formed parent map is judged, not skipped', async () => {
    const h = await harness()
    const championId = await createVerifiedChampion(h)

    // The replay task is parentless, so its map has no child to point at: the
    // declaration is judged at acceptance (fails closed) rather than skipped.
    const outcome = await h.runtime.replayTask(STORE, championId, {
      lineage: 'evolution-replay:p4',
      spawn: false,
      contract: {
        objective: 'candidate contract',
        acceptanceCriteria: [{
          criterionId: 'cand-1',
          description: 'the candidate combination',
          verificationMode: 'composite',
          requiredEvidence: [],
          mandatory: true,
          childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }],
        }],
        requiredCapabilities: [],
      },
    }, ROOT_SESSION)

    expect(outcome.status).toBe('failed')
    const replayEvidence = evidenceFor(h, outcome.runId)
    expect(replayEvidence[0]!.verifierResults[0]!.details).toContain('child #0')
    const replayTaskId = (await h.task.snapshotIn(STORE)).tasks.map(item => item.taskId).find(id => id !== championId)
    expect(replayTaskId).toBeDefined()
    expect((await h.task.taskIn(STORE, replayTaskId!)).status).toBe('failed')
  })
})
