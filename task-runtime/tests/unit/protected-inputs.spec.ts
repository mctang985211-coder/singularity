import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion, EvidenceBundle, TaskEvent, VerificationResult } from '../../../task/src/index.ts'
import { TaskService, contractDigest, rootTaskStoreId } from '../../../task/src/index.ts'
import type { ChildOutcome, Config, DecomposeSpec } from '../../src/index.ts'
import {
  TaskRuntime,
  contractDefects,
  fixProtectedInputs,
  fixSpecProtectedInputs,
  normalizeDecomposition,
  protectedInputDefects,
} from '../../src/index.ts'

/**
 * S1-V slice 2, the admission/consumer half: a criterion's declared protected
 * acceptance inputs are fixed as a byte identity before the contract is
 * written, on the ordinary decomposition path and on replay, and every real
 * consumer (normalization, admission, the model-facing tool, the two render
 * surfaces) reads that fixed identity.
 *
 * The integration cases deliberately drive the real `TaskRuntime` over the
 * real `TaskService`: the fixing is only worth anything if the persisted
 * contract, the proposal digest and the refusal behaviour are what a reader of
 * the store sees. The pure module functions are covered directly as well,
 * because the shape rules they own are the boundary the tools, the replay path
 * and the pre-judgement re-check all depend on.
 */
const ROOT_SESSION = 'root-session'
const STORE = rootTaskStoreId(ROOT_SESSION)

/** SHA-256 of a file's bytes, computed here so the implementation is never confirmed against itself. */
function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

type Harness = ReturnType<typeof harness>

/**
 * The real runtime over the real task service, with one graph whose env is a
 * temp checkout directory. `checkout: undefined` is the deployment that cannot
 * resolve the session's checkout at all — the case a declared input must be
 * refused under rather than fixed against a guess.
 */
function harness(options: { checkout?: string } = {}) {
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

  const spawned: Array<{ sessionId: string; prompt: string; contract?: string }> = []
  let idleBehavior: ((sessionId: string) => Promise<void>) | undefined
  const agentRuntime = {
    spawn: vi.fn(async (_parent: unknown, request: { sessionId: string; prompt: Array<{ type: 'text'; text: string }>; contract?: string }) => {
      spawned.push({
        sessionId: request.sessionId,
        prompt: request.prompt.map(block => block.text).join('\n'),
        ...(request.contract === undefined ? {} : { contract: request.contract }),
      })
      return {
        agent: {
          id: request.sessionId,
          cancel: vi.fn(),
          whenIdle: vi.fn(() => (idleBehavior ?? defaultIdle)(request.sessionId)),
        },
        dispose: vi.fn(async () => {}),
      }
    }),
  }
  const graphs = {
    graphForSession: vi.fn(async (_sessionId: string) => ({
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: ROOT_SESSION,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
      createdAt: 0,
      ready: true,
    })),
  }

  let taskService!: TaskService
  const verifier = {
    verifierIds: vi.fn(() => ['command', 'composite', 'review']),
    verifyRun: vi.fn(async (storeId: string, runId: string): Promise<EvidenceBundle> => {
      const run = await taskService.runIn(storeId, runId)
      const instance = await taskService.taskIn(storeId, run.taskId)
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'pass',
        verifierId: 'fake-verifier',
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: run.taskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: 'fake-verifier',
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await taskService.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    }),
  }

  const listeners = new Map<string, Set<(...args: never[]) => unknown>>()
  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: () => {},
    // A real (small) event bus: the runtime's run watcher rides `task/change`
    // (A3 §3.1), and an `on` that swallowed subscriptions would test a watcher
    // that never fires.
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(event) ?? [])]) (listener as (...a: unknown[]) => unknown)(...args)
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    sessionPersistence: persistence,
    agentRuntime,
    agents: { get: (sessionId: string) => ({ id: sessionId }) },
    graphs,
  }
  if (options.checkout !== undefined) {
    ctx.envBuilder = { store: { get: (_envId: string) => ({ path: options.checkout as string }) } }
  }
  taskService = new TaskService(ctx as never)
  ctx.task = taskService
  ctx.verifier = verifier
  // A temp run-binding root: workspace markers and run snapshots belong to the
  // deployment under test, never to the developer's own `~/.dsh`.
  const runtime = new TaskRuntime(ctx as never, { runBindingRoot: join(options.checkout ?? tmpdir(), 'run-bindings') } as Config)
  // A3's worker protocol: a worker hands its result in through the explicit
  // submission entry and then goes idle — an idle is not a completion.
  const defaultIdle = async (sessionId: string): Promise<void> => {
    await runtime.submitResult(sessionId, { summary: `done: ${sessionId}` })
  }
  return {
    ctx,
    sessions,
    task: taskService,
    runtime,
    verifier,
    spawned,
    graphs,
    setIdleBehavior: (behavior: (sessionId: string) => Promise<void>) => { idleBehavior = behavior },
  }
}

/**
 * Admit a batch and wait for it to settle: `decomposeAndRun` returns at the
 * atomic commit (A3 §3.1), so a test that reads outcomes asks `awaitBatch`.
 */
async function decomposeAndSettle(
  h: Harness,
  ...args: Parameters<TaskRuntime['decomposeAndRun']>
): Promise<ChildOutcome[]> {
  const { batchId } = await h.runtime.decomposeAndRun(...args)
  return await h.runtime.awaitBatch(args[0], batchId)
}

/** Every persisted task-store event, read back from the session log the store writes to. */
function taskEvents(h: Harness): TaskEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events.map(item => item.data as TaskEvent))
}

async function createRoot(h: Harness) {
  return h.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT_SESSION }, ROOT_SESSION)
}

function childSpec(objective: string, overrides: Record<string, unknown> = {}) {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    ...overrides,
  } as DecomposeSpec['children'][number]
}

/** A criterion with one declared protected input, in the authoring (spec) form the tool sends. */
function declaredCriterion(id: string, path: string): Record<string, unknown> {
  return { criterionId: id, description: `${id} passes`, command: 'true', mode: 'deterministic', protectedInputs: [path] }
}

/**
 * The same declaration in the stored-criterion form a replay candidate contract
 * carries: `verificationMode`/`requiredEvidence`/`mandatory`, because the
 * replay path reads a caller's criteria verbatim (no normalization fills
 * defaults for it).
 */
function candidateCriterion(id: string, path: string): Record<string, unknown> {
  return {
    criterionId: id,
    description: `${id} passes`,
    command: 'true',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    protectedInputs: [path],
  }
}

/** The fixed form a stored contract carries, so a test can compare against the declared spelling. */
function fixedRef(path: string, file: string): { path: string; sha256: string } {
  return { path, sha256: sha256Of(file) }
}

let checkout: string

beforeEach(() => {
  checkout = mkdtempSync(join(tmpdir(), 'protected-inputs-'))
})

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true })
})

describe('fixProtectedInputs', () => {
  test('fixes every declared path against the checkout, keeping the declared spelling', async () => {
    writeFileSync(join(checkout, 'check.sh'), '#!/bin/sh\nexit 0\n')
    writeFileSync(join(checkout, 'thresholds.json'), '{ "ratio": 0.9 }\n')

    const { refs, reasons } = await fixProtectedInputs(['check.sh', 'thresholds.json'], checkout, 'child 0 criterion 1')

    expect(reasons).toEqual([])
    expect(refs).toEqual([
      { path: 'check.sh', sha256: sha256Of(join(checkout, 'check.sh')) },
      { path: 'thresholds.json', sha256: sha256Of(join(checkout, 'thresholds.json')) },
    ])
    // no writes of any kind: both files still hash to what the refs recorded
    expect(sha256Of(join(checkout, 'check.sh'))).toBe(refs[0]!.sha256)
    expect(sha256Of(join(checkout, 'thresholds.json'))).toBe(refs[1]!.sha256)
  })

  test('resolves a declared subpath against the checkout while keeping the declared spelling', async () => {
    mkdirSync(join(checkout, 'tests'), { recursive: true })
    writeFileSync(join(checkout, 'tests', 'check.sh'), 'exit 0\n')

    const { refs, reasons } = await fixProtectedInputs(['tests/check.sh'], checkout, 'child 0 criterion 1')

    expect(reasons).toEqual([])
    expect(refs).toEqual([{ path: 'tests/check.sh', sha256: sha256Of(join(checkout, 'tests', 'check.sh')) }])
  })

  test('fixes an absolute declaration without prepending the checkout', async () => {
    const absolute = join(checkout, 'thresholds.json')
    writeFileSync(absolute, '{ "ratio": 0.9 }\n')

    const { refs, reasons } = await fixProtectedInputs([absolute], checkout, 'child 0 criterion 1')

    expect(reasons).toEqual([])
    expect(refs).toEqual([{ path: absolute, sha256: sha256Of(absolute) }])
  })

  test('keeps one entry per distinct declared path, in first-declaration order', async () => {
    writeFileSync(join(checkout, 'a.sh'), 'a')
    writeFileSync(join(checkout, 'b.sh'), 'b')

    const { refs, reasons } = await fixProtectedInputs(['b.sh', 'a.sh', 'b.sh'], checkout, 'child 0 criterion 1')

    expect(reasons).toEqual([])
    expect(refs.map(ref => ref.path)).toEqual(['b.sh', 'a.sh'])
    expect(refs[0]!.sha256).toBe(sha256Of(join(checkout, 'b.sh')))
    expect(refs[1]!.sha256).toBe(sha256Of(join(checkout, 'a.sh')))
  })

  test('refuses a missing file with a reason naming the label and the path', async () => {
    const { refs, reasons } = await fixProtectedInputs(['tests/check.sh'], checkout, 'child 0 criterion "ac1"')

    expect(refs).toEqual([])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('child 0 criterion "ac1" protectedInputs')
    expect(reasons[0]).toContain('tests/check.sh')
    expect(reasons[0]).toMatch(/cannot be read/)
  })

  test('refuses a declared path when the session checkout cannot be resolved', async () => {
    const { refs, reasons } = await fixProtectedInputs(['check.sh'], undefined, 'child 0 criterion 1')

    expect(refs).toEqual([])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('child 0 criterion 1 protectedInputs')
    expect(reasons[0]).toContain('checkout')
  })

  test('does nothing, and needs no checkout, when no path is declared', async () => {
    const { refs, reasons } = await fixProtectedInputs([], undefined, 'child 0 criterion 1')

    expect(refs).toEqual([])
    expect(reasons).toEqual([])
  })
})

describe('fixSpecProtectedInputs', () => {
  function declaredSpec(): DecomposeSpec {
    return {
      reason: 'split the work',
      children: [
        {
          objective: 'child a',
          acceptanceCriteria: [
            declaredCriterion('ac1', 'check.sh'),
            { criterionId: 'ac2', description: 'docs build', command: 'true' },
          ],
        },
        { objective: 'child b', acceptanceCriteria: [{ description: 'plain', command: 'true' }] },
      ],
    } as unknown as DecomposeSpec
  }

  test('replaces the declared string form with the fixed identity, rebuilding only what it touches', async () => {
    writeFileSync(join(checkout, 'check.sh'), 'exit 0\n')
    const spec = declaredSpec()
    const untouchedCriterion = spec.children[0]!.acceptanceCriteria[1]
    const untouchedChild = spec.children[1]

    const { spec: fixed, reasons } = await fixSpecProtectedInputs(spec, checkout)

    expect(reasons).toEqual([])
    expect(fixed.children[0]!.acceptanceCriteria[0]!.protectedInputs)
      .toEqual([fixedRef('check.sh', join(checkout, 'check.sh'))])
    // the criterion that declared nothing and the child that declared nothing
    // are carried by reference: only the touched objects are rebuilt
    expect(fixed.children[0]!.acceptanceCriteria[1]).toBe(untouchedCriterion)
    expect(fixed.children[1]).toBe(untouchedChild)
    // the caller's input is never mutated
    expect(spec.children[0]!.acceptanceCriteria[0]!.protectedInputs).toEqual(['check.sh'])
  })

  test('leaves the already-fixed form and every malformed declaration exactly as declared', async () => {
    const shapes: Record<string, unknown> = {
      'the fixed form': [{ path: 'check.sh', sha256: 'c'.repeat(64) }],
      'a bare string': 'check.sh',
      'a mixed array': ['check.sh', { path: 'b.sh', sha256: 'b'.repeat(64) }],
      'a blank entry': ['  '],
      'an incomplete object': [{ path: 'a.sh' }],
    }
    for (const [name, declared] of Object.entries(shapes)) {
      const spec = {
        reason: 'split the work',
        children: [{ objective: 'child a', acceptanceCriteria: [{ description: 'x', command: 'true', protectedInputs: declared }] }],
      } as unknown as DecomposeSpec

      const { spec: fixed, reasons } = await fixSpecProtectedInputs(spec, checkout)

      expect(reasons, name).toEqual([])
      expect(fixed.children[0]!.acceptanceCriteria[0]!.protectedInputs, name).toEqual(declared)
    }
  })

  test('names the criterion the way normalize.ts does: the declared id when present, the position otherwise', async () => {
    const spec = {
      reason: 'split the work',
      children: [{
        objective: 'child a',
        acceptanceCriteria: [
          declaredCriterion('ac1', 'missing-a.sh'),
          { description: 'b', command: 'true', protectedInputs: ['missing-b.sh'] },
        ],
      }],
    } as unknown as DecomposeSpec

    const { reasons } = await fixSpecProtectedInputs(spec, checkout)

    expect(reasons).toHaveLength(2)
    expect(reasons[0]).toContain('child 0 criterion "ac1" protectedInputs')
    expect(reasons[0]).toContain('missing-a.sh')
    expect(reasons[1]).toContain('child 0 criterion 2 protectedInputs')
    expect(reasons[1]).toContain('missing-b.sh')
  })
})

describe('protectedInputDefects', () => {
  function criterion(protectedInputs: unknown): AcceptanceCriterion {
    return {
      criterionId: 'ac1',
      description: 'suite passes',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
      protectedInputs,
    } as unknown as AcceptanceCriterion
  }

  test('reports nothing for an absent declaration or a well-formed fixed form', () => {
    const absent = criterion(undefined)
    delete (absent as { protectedInputs?: unknown }).protectedInputs

    expect(protectedInputDefects([absent], 'child 0 ("t-1")')).toEqual([])
    expect(protectedInputDefects([criterion([])], 'child 0 ("t-1")')).toEqual([])
    expect(protectedInputDefects(
      [criterion([{ path: 'check.sh', sha256: '0'.repeat(64) }])],
      'child 0 ("t-1")',
    )).toEqual([])
  })

  test('refuses every malformed fixed form, naming the label, the criterion and the defect', () => {
    const cases: Array<[string, unknown, string]> = [
      ['a non-array declaration', 'check.sh', 'must be an array'],
      ['a string entry', ['check.sh'], 'must be an object'],
      ['a null entry', [null], 'must be an object'],
      ['a missing sha256', [{ path: 'check.sh' }], 'sha256'],
      ['a blank path', [{ path: '  ', sha256: '0'.repeat(64) }], 'path'],
      ['a non-string path', [{ path: 7, sha256: '0'.repeat(64) }], 'path'],
      ['an uppercase digest', [{ path: 'a.sh', sha256: 'A'.repeat(64) }], 'sha256'],
      ['a short digest', [{ path: 'a.sh', sha256: 'abc' }], 'sha256'],
      ['an unknown entry key', [{ path: 'a.sh', sha256: '0'.repeat(64), note: 'x' }], 'unknown field'],
    ]
    for (const [name, declared, expected] of cases) {
      const reasons = protectedInputDefects([criterion(declared)], 'child 0 ("t-1")')
      expect(reasons.length, name).toBeGreaterThan(0)
      expect(reasons.join(' | '), name).toContain('child 0 ("t-1") criterion "ac1" protectedInputs')
      expect(reasons.join(' | '), name).toContain(expected)
    }
  })
})

describe('the fixed-form rule is shared by normalization and admission', () => {
  test('normalization carries the fixed declaration verbatim into the contract and its digest', () => {
    const fixedForm = [{ path: 'check.sh', sha256: 'c'.repeat(64) }]
    const result = normalizeDecomposition({
      reason: 'split the work',
      children: [{
        objective: 'child a',
        acceptanceCriteria: [{ description: 'suite passes', command: 'true', protectedInputs: fixedForm }],
      }],
    }, {
      storeId: STORE,
      parentTaskId: 't-parent',
      parentRunId: 'r-parent',
      callerSessionId: ROOT_SESSION,
      admissionContext: { maxDepth: 4, maxChildren: 8, auditOnly: {} },
    })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.batch.children[0]!.contract.acceptanceCriteria[0]!.protectedInputs : undefined)
      .toEqual(fixedForm)
  })

  test('contractDefects accepts the fixed form and refuses the declared string form', () => {
    const base = {
      criterionId: 'ac1',
      description: 'suite passes',
      verificationMode: 'deterministic' as const,
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    }
    const fixedForm: AcceptanceCriterion = { ...base, protectedInputs: [{ path: 'a.sh', sha256: 'd'.repeat(64) }] }
    const stringForm = { ...base, protectedInputs: ['a.sh'] } as unknown as AcceptanceCriterion

    expect(contractDefects([fixedForm], 'child 0 ("t-1")')).toEqual([])
    const reasons = contractDefects([stringForm], 'child 0 ("t-1")')
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('child 0 ("t-1") criterion "ac1" protectedInputs')
    expect(reasons[0]).toContain('must be an object')
  })
})

describe('TaskRuntime.decomposeAndRun: protected inputs at admission', () => {
  function protectedSpec(path: string): DecomposeSpec {
    return {
      reason: 'split the work',
      children: [childSpec('child a', { acceptanceCriteria: [declaredCriterion('ac1', path)] })],
    } as unknown as DecomposeSpec
  }

  test('fixes a declared input into the persisted child contract and into both content identities', async () => {
    const file = join(checkout, 'check.sh')
    writeFileSync(file, 'exit 0\n')
    const h = harness({ checkout })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const spec = protectedSpec('check.sh')

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, spec)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // the contract as the store wrote it, read back from the TaskCreated event
    const created = taskEvents(h).find(item => item.kind === 'TaskCreated' && item.taskId === outcomes[0]!.taskId)
    expect(created?.kind).toBe('TaskCreated')
    const contract = created?.kind === 'TaskCreated' ? created.payload.task.contract : undefined
    expect(contract!.acceptanceCriteria[0]!.protectedInputs).toEqual([fixedRef('check.sh', file)])
    // the runtime wrote the identity the pure entry computes over the fixed
    // proposal: the fixed digest, not a later read, is what it covers
    const fixed = await fixSpecProtectedInputs(spec, checkout)
    const expected = normalizeDecomposition(fixed.spec, {
      storeId: STORE,
      parentTaskId: rootTaskId,
      parentRunId: rootRunId,
      callerSessionId: ROOT_SESSION,
      admissionContext: { maxDepth: 4, maxChildren: 8, auditOnly: {} },
    })
    expect(expected.ok).toBe(true)
    expect(expected.ok ? contractDigest(expected.batch.children[0]!.contract) : undefined)
      .toBe(contractDigest(contract!))
    const decomposed = taskEvents(h).find(item => item.kind === 'TaskDecomposed' && item.taskId === rootTaskId)
    expect(decomposed?.kind === 'TaskDecomposed' ? decomposed.payload.admission?.proposalDigest : undefined)
      .toBe(expected.ok ? expected.batch.admission.proposalDigest : undefined)
  })

  test('the worker sees the fixed protected input in its spawn prompt and contract block before any task_read', async () => {
    writeFileSync(join(checkout, 'check.sh'), 'exit 0\n')
    const h = harness({ checkout })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)

    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, protectedSpec('check.sh'))

    const call = h.spawned[0]!
    // Both surfaces a worker reads before its first `task_read` carry the same
    // cell, rendered from the fixed refs the store holds rather than from the
    // caller's declaration.
    const row = '| ac1 | deterministic | yes | ac1 passes | true | check.sh |'
    expect(call.prompt).toContain(row)
    expect(call.contract).toBeDefined()
    expect(call.contract).toContain(row)
    expect(call.prompt).toContain('- A criterion\'s declared protected inputs must not be modified')
    expect(call.prompt).toContain('a changed or missing input fails the criterion, naming the path')
  })

  test('changing the protected file changes the child contract identity and the proposal identity', async () => {
    const file = join(checkout, 'check.sh')
    writeFileSync(file, 'exit 0\n')
    const h = harness({ checkout })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const spec = protectedSpec('check.sh')
    const identity = async (directory: string) => {
      const fixed = await fixSpecProtectedInputs(spec, directory)
      const result = normalizeDecomposition(fixed.spec, {
        storeId: STORE,
        parentTaskId: rootTaskId,
        parentRunId: rootRunId,
        callerSessionId: ROOT_SESSION,
        admissionContext: { maxDepth: 4, maxChildren: 8, auditOnly: {} },
      })
      if (!result.ok) throw new Error(result.reasons.join('\n'))
      return {
        contractDigest: contractDigest(result.batch.children[0]!.contract),
        proposalDigest: result.batch.admission.proposalDigest,
      }
    }
    const before = await identity(checkout)
    // identical bytes in another directory keep the identity: the declared
    // path, not the checkout it was read from, is what the digests describe
    const other = mkdtempSync(join(tmpdir(), 'protected-inputs-other-'))
    try {
      writeFileSync(join(other, 'check.sh'), 'exit 0\n')
      expect(await identity(other), 'identical bytes elsewhere').toEqual(before)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }

    writeFileSync(file, 'exit 1\n')
    const after = await identity(checkout)
    expect(after.contractDigest).not.toBe(before.contractDigest)
    expect(after.proposalDigest).not.toBe(before.proposalDigest)
  })

  test('an unreadable declared path refuses the whole batch with zero side effects', async () => {
    const h = harness({ checkout })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const eventsBefore = taskEvents(h).length

    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, protectedSpec('tests/missing.sh')))
      .rejects.toThrow(
        /task-runtime: contract rejected decomposition of ".+":\n- child 0 criterion "ac1" protectedInputs path "tests\/missing\.sh" cannot be read/,
      )

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks.map(task => task.taskId)).toEqual([rootTaskId])
    expect(snapshot.runs.map(run => run.runId)).toEqual([rootRunId])
    expect(taskEvents(h).some(item => item.kind === 'TaskDecomposed')).toBe(false)
    expect(taskEvents(h).length).toBe(eventsBefore)
    expect(h.spawned).toEqual([])
    expect(h.verifier.verifyRun).not.toHaveBeenCalled()
  })

  test('a declared input is refused when the session checkout cannot be resolved', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const tasksBefore = (await h.task.snapshotIn(STORE)).tasks.length

    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, protectedSpec('check.sh')))
      .rejects.toThrow(/task-runtime: contract rejected decomposition of ".+":\n- child 0 criterion "ac1" protectedInputs cannot be fixed/)

    expect(h.spawned).toEqual([])
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(tasksBefore)
  })

  test('a criterion with no declared input is not protected: nothing is read, nothing is claimed', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a')],
    } as DecomposeSpec)

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const child = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(Object.keys(child.acceptanceCriteria[0]!)).not.toContain('protectedInputs')
    expect(protectedInputDefects(child.acceptanceCriteria, `child 0 ("${child.taskId}")`)).toEqual([])
  })

  test('a malformed proposal is refused by normalization, not crashed on by the fixing step', async () => {
    const h = harness({ checkout })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const cases: Array<[unknown, RegExp]> = [
      [{ reason: 'split the work' }, /decomposition requires at least one child/],
      [{ reason: 'split the work', children: 'child a' }, /decomposition children must be an array/],
      [{ reason: 'split the work', children: [null] }, /child 0 must be an object/],
      [{ reason: 'split the work', children: [{ objective: 'child a', acceptanceCriteria: 'nope' }] }, /child 0 acceptanceCriteria must be an array/],
    ]
    for (const [spec, expected] of cases) {
      await expect(
        decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, spec as DecomposeSpec),
        JSON.stringify(spec),
      ).rejects.toThrow(expected)
    }

    expect(h.spawned).toEqual([])
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
  })
})

describe('TaskRuntime.replayTask: protected inputs on the replay path', () => {
  async function champion(h: Harness) {
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('champion work')],
    } as DecomposeSpec)
    expect(outcomes[0]!.status).toBe('verified')
    return { championTaskId: outcomes[0]!.taskId }
  }

  /** A terminal task whose criteria carry an already-fixed (or deliberately malformed) declaration. */
  async function storedChampion(h: Harness, criterion: Record<string, unknown>): Promise<string> {
    const { taskId: rootTaskId } = await createRoot(h)
    const taskId = 't-broken'
    const runId = 'r-broken'
    await h.task.createTaskIn(STORE, {
      taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      objective: 'broken champion',
      depth: 0,
      acceptanceCriteria: [criterion as unknown as AcceptanceCriterion],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(STORE, {
      runId,
      taskId,
      sessionId: 's-champion',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      // Born active like every run this build creates (A3 §1.1).
      executionPhase: 'active',
      status: 'running',
      startedAt: new Date().toISOString(),
    }, 'tester')
    await h.task.markRunStatusIn(STORE, taskId, runId, 'verifying', 'tester')
    await h.task.recordEvidenceIn(STORE, {
      evidenceId: `e-${runId}`,
      taskRunId: runId,
      taskId,
      artifacts: [],
      verifierResults: [{ criterionId: String(criterion.criterionId), status: 'pass', verifierId: 'fake-verifier' }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }, 'tester')
    await h.task.markRunStatusIn(STORE, taskId, runId, 'verified', 'tester')
    return taskId
  }

  test('fixes the declared string form of a candidate contract against the replay caller\'s checkout', async () => {
    const file = join(checkout, 'candidate-check.sh')
    writeFileSync(file, 'exit 0\n')
    const h = harness({ checkout })
    const { championTaskId } = await champion(h)

    const outcome = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p1',
      spawn: false,
      contract: {
        objective: 'candidate work',
        acceptanceCriteria: [candidateCriterion('ac1', 'candidate-check.sh') as unknown as AcceptanceCriterion],
        requiredCapabilities: [],
      },
    }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.contract!.acceptanceCriteria[0]!.protectedInputs)
      .toEqual([fixedRef('candidate-check.sh', file)])
  })

  test('carries a champion\'s stored fixed form verbatim and never re-fixes it', async () => {
    const file = join(checkout, 'champion-check.sh')
    writeFileSync(file, 'exit 0\n')
    const h = harness({ checkout })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('champion work', { acceptanceCriteria: [declaredCriterion('ac1', 'champion-check.sh')] })],
    } as unknown as DecomposeSpec)
    const championTaskId = outcomes[0]!.taskId
    const champion = await h.task.taskIn(STORE, championTaskId)
    const stored = champion.contract!.acceptanceCriteria[0]!.protectedInputs!
    expect(stored).toEqual([fixedRef('champion-check.sh', file)])
    // the file moves on after admission: the champion's stored identity is the
    // historical one the re-check compares against, so a replay must carry it
    // as stored rather than re-reading the file
    writeFileSync(file, 'tampered\n')

    const outcome = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p2',
      spawn: false,
    }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.contract!.acceptanceCriteria[0]!.protectedInputs).toEqual(stored)
    expect(stored[0]!.sha256).not.toBe(sha256Of(file))
  })

  test('refuses an unreadable declared input before anything persists', async () => {
    const h = harness({ checkout })
    const { championTaskId } = await champion(h)
    const tasksBefore = (await h.task.snapshotIn(STORE)).tasks.length

    await expect(h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p3',
      spawn: false,
      contract: {
        objective: 'candidate work',
        acceptanceCriteria: [declaredCriterion('ac1', 'missing-candidate.sh') as unknown as AcceptanceCriterion],
        requiredCapabilities: [],
      },
    }, ROOT_SESSION)).rejects.toThrow(
      /task-runtime: replay of ".+" rejected:\n- replay of ".+" criterion "ac1" protectedInputs path "missing-candidate\.sh" cannot be read/,
    )

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(tasksBefore)
  })

  test('refuses a declaration when the replay caller\'s checkout cannot be resolved', async () => {
    const h = harness()
    const { championTaskId } = await champion(h)

    await expect(h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p4',
      spawn: false,
      contract: {
        objective: 'candidate work',
        acceptanceCriteria: [candidateCriterion('ac1', 'candidate-check.sh') as unknown as AcceptanceCriterion],
        requiredCapabilities: [],
      },
    }, ROOT_SESSION)).rejects.toThrow(/replay of ".+" rejected:\n- replay of ".+" criterion "ac1" protectedInputs cannot be fixed/)
  })

  test('refuses a malformed fixed form carried by the champion', async () => {
    const h = harness({ checkout })
    const broken = await storedChampion(h, { ...candidateCriterion('ac1', 'check.sh'), protectedInputs: 'check.sh' })

    await expect(h.runtime.replayTask(STORE, broken, { lineage: 'evolution-replay:p5', spawn: false }, ROOT_SESSION))
      .rejects.toThrow(/replay of "t-broken" rejected:\n- replay of "t-broken" criterion "ac1" protectedInputs must be an array/)
  })

  test('accepts a champion whose stored fixed form is well formed', async () => {
    const h = harness({ checkout })
    const refs = [{ path: 'check.sh', sha256: 'f'.repeat(64) }]
    const ok = await storedChampion(h, { ...candidateCriterion('ac1', 'check.sh'), protectedInputs: refs })

    const outcome = await h.runtime.replayTask(STORE, ok, { lineage: 'evolution-replay:p6', spawn: false }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.contract!.acceptanceCriteria[0]!.protectedInputs).toEqual(refs)
  })
})
