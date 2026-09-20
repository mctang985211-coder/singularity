import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type {
  AcceptanceCriterion,
  EvidenceBundle,
  TaskInstance,
  TaskRun,
  VerificationResult,
  Verifier,
  VerifyRequest,
} from '../../../task/src/types.ts'
import { LOG_TAIL_MAX_CHARS, LOG_TAIL_MAX_LINES, ReviewVerifier, VerifierRegistry } from '../../src/index.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const STORE = 'sg-t-root-session'

function criterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    criterionId: 'c1',
    description: 'exits zero',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    command: 'node -e "process.exit(0)"',
    ...overrides,
  }
}

function task(criteria: AcceptanceCriterion[], overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    taskId: 't1',
    definitionRef: { taskType: 'build', version: 1 },
    objective: 'build the thing',
    depth: 0,
    acceptanceCriteria: criteria,
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'verifying',
    runIds: ['r1'],
    childTaskIds: [],
    ...overrides,
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: 'r1',
    taskId: 't1',
    sessionId: 's1',
    capabilitySnapshot: [],
    artifacts: [{ artifactId: 'a1', kind: 'patch', uri: 'bb://artifact/a1' }],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...overrides,
  }
}

function harness(options: { task: TaskInstance; run?: TaskRun; children?: TaskInstance[] }) {
  const recorded: EvidenceBundle[] = []
  const warnings: string[] = []
  const taskService = {
    runIn: vi.fn(async (_storeId: string, runId: string) => ({ ...(options.run ?? run()), runId })),
    taskIn: vi.fn(async () => options.task),
    childrenIn: vi.fn(async () => options.children ?? []),
    recordEvidenceIn: vi.fn(async (_storeId: string, bundle: EvidenceBundle, _actor: string) => {
      recorded.push(bundle)
    }),
  }
  const ctx = {
    reflect: { provide: () => {} },
    task: taskService,
    logger: () => ({ warn: (message: string) => { warnings.push(message) } }),
  }
  return { ctx, taskService, recorded, warnings }
}

async function setup(options: { task: TaskInstance; run?: TaskRun; children?: TaskInstance[] }) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'verifier-registry-'))
  const cwd = await mkdtemp(join(tmpdir(), 'verifier-run-'))
  const h = harness(options)
  const registry = new VerifierRegistry(h.ctx as never, { evidenceRoot })
  return { ...h, evidenceRoot, cwd, registry }
}

describe('VerifierRegistry mode dispatch', () => {
  test('routes each criterion to the built-in verifier supporting its mode', async () => {
    const { registry, cwd } = await setup({
      task: task([
        criterion({ criterionId: 'cmd', verificationMode: 'deterministic' }),
        criterion({ criterionId: 'rev', verificationMode: 'review', command: undefined }),
        criterion({ criterionId: 'frm', verificationMode: 'formal', command: undefined }),
        criterion({ criterionId: 'cmp', verificationMode: 'composite', command: undefined }),
      ]),
      children: [
        { ...task([], { taskId: 'c1', status: 'verified', depth: 1 }) },
        { ...task([], { taskId: 'c2', status: 'verified', depth: 1 }) },
      ],
    })
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    expect(bundle.verifierResults.map(result => [result.criterionId, result.verifierId, result.status])).toEqual([
      ['cmd', 'command', 'pass'],
      ['rev', 'review', 'inconclusive'],
      ['frm', 'review', 'inconclusive'],
      ['cmp', 'composite', 'pass'],
    ])
    expect(bundle.verifierResults[1]!.details).toBe('manual review required')
  })

  test('a later registration wins dispatch for a built-in mode', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const custom: Verifier = {
      id: 'custom-command',
      supports: mode => mode === 'deterministic',
      verify: vi.fn(async (req: VerifyRequest) => req.criteria.map(c => ({
        criterionId: c.criterionId,
        status: 'pass' as const,
        verifierId: 'custom-command',
      }))),
    }
    registry.register(custom)
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(custom.verify).toHaveBeenCalledOnce()
    expect(bundle.verifierResults).toEqual([
      { criterionId: 'c1', status: 'pass', verifierId: 'custom-command' },
    ])
  })

  test('register rejects duplicate verifier ids and the disposer restores dispatch', async () => {
    const { registry } = await setup({ task: task([criterion({ verificationMode: 'review', command: undefined })]) })
    const replacement: Verifier = {
      id: 'review-2',
      supports: mode => mode === 'review',
      verify: async req => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'fail' as const, verifierId: 'review-2' })),
    }
    const dispose = registry.register(replacement)
    expect((await registry.verifyRun(STORE, 'r1')).verifierResults[0]!.verifierId).toBe('review-2')
    dispose()
    expect((await registry.verifyRun(STORE, 'r1')).verifierResults[0]!.verifierId).toBe('review')
    registry.register(replacement)
    expect(() => registry.register(replacement)).toThrow('duplicate verifier')
  })
})

describe('VerifierRegistry evidence bundles', () => {
  test('records one claim per result with derived claim ids and returns the recorded bundle', async () => {
    const { registry, taskService, recorded, cwd } = await setup({
      task: task([
        criterion({ criterionId: 'c1' }),
        criterion({ criterionId: 'c2', command: 'node -e "process.exit(1)"' }),
      ]),
    })
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    expect(bundle.taskRunId).toBe('r1')
    expect(bundle.taskId).toBe('t1')
    expect(bundle.evidenceId).toContain('r1')
    expect(bundle.generatedAt).toBeDefined()
    expect(bundle.artifacts).toEqual([{ artifactId: 'a1', kind: 'patch', uri: 'bb://artifact/a1' }])
    expect(bundle.verifierResults.map(result => result.status)).toEqual(['pass', 'fail'])
    expect(bundle.claims).toHaveLength(bundle.verifierResults.length)
    expect(bundle.claims.map(claim => claim.claimId)).toEqual([
      `${bundle.evidenceId}#c1`,
      `${bundle.evidenceId}#c2`,
    ])
    expect(bundle.claims.map(claim => [claim.criterionId, claim.status, claim.verifierId])).toEqual([
      ['c1', 'pass', 'command'],
      ['c2', 'fail', 'command'],
    ])
    expect(taskService.recordEvidenceIn).toHaveBeenCalledOnce()
    expect(recorded).toEqual([bundle])
  })

  test('command results keep logRef relative to evidenceRoot and the log lands under it', async () => {
    const { registry, evidenceRoot, cwd } = await setup({ task: task([criterion()]) })
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    const logRef = bundle.verifierResults[0]!.logRef!
    expect(isAbsolute(logRef)).toBe(false)
    expect(logRef).toBe(`${STORE}/r1/c1.log`)
    expect(await readFile(join(evidenceRoot, logRef), 'utf8')).toBe('')
  })

  test('an absolute logRef inside evidenceRoot is normalized to a relative one', async () => {
    const { registry, evidenceRoot } = await setup({ task: task([criterion()]) })
    const absolute: Verifier = {
      id: 'absolute-log',
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map((c): VerificationResult => ({
        criterionId: c.criterionId,
        status: 'pass',
        verifierId: 'absolute-log',
        logRef: join(evidenceRoot, STORE, 'r1', 'abs.log'),
      })),
    }
    registry.register(absolute)
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]!.logRef).toBe(`${STORE}/r1/abs.log`)
  })

  test('an absolute logRef escaping evidenceRoot fails the run loudly', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const escaping: Verifier = {
      id: 'escaping-log',
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map((c): VerificationResult => ({
        criterionId: c.criterionId,
        status: 'pass',
        verifierId: 'escaping-log',
        logRef: '/tmp/elsewhere.log',
      })),
    }
    registry.register(escaping)
    await expect(registry.verifyRun(STORE, 'r1')).rejects.toThrow('escapes evidenceRoot')
  })

  test('composite criteria fail through the registry when a child is unverified', async () => {
    const { registry } = await setup({
      task: task([criterion({ criterionId: 'cmp', verificationMode: 'composite', command: undefined })]),
      children: [{ ...task([], { taskId: 'c1', status: 'running', depth: 1 }) }],
    })
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]).toMatchObject({ criterionId: 'cmp', verifierId: 'composite', status: 'fail' })
  })
})

describe('VerifierRegistry logTail', () => {
  test('returns the excerpt a failed command logged, addressed by its relative logRef', async () => {
    const { registry, cwd } = await setup({
      task: task([criterion({ command: 'node -e "console.log(\'boom\'); process.exit(1)"' })]),
    })
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    const tail = await registry.logTail(bundle.verifierResults[0]!.logRef!)
    expect(tail).toBe('boom')
  })

  test('truncates to the line and char caps, keeping the end of the log', async () => {
    const { registry, evidenceRoot } = await setup({ task: task([]) })
    await mkdir(join(evidenceRoot, STORE, 'r1'), { recursive: true })
    const manyLines = Array.from({ length: LOG_TAIL_MAX_LINES + 20 }, (_item, index) => `line-${index}`).join('\n')
    await writeFile(join(evidenceRoot, STORE, 'r1', 'lines.log'), manyLines)
    const lineTail = await registry.logTail(`${STORE}/r1/lines.log`)
    expect(lineTail).toBeDefined()
    expect(lineTail!.split('\n')).toHaveLength(LOG_TAIL_MAX_LINES)
    expect(lineTail).toContain(`line-${LOG_TAIL_MAX_LINES + 19}`)
    expect(lineTail).not.toContain('line-19')

    const longLine = 'x'.repeat(LOG_TAIL_MAX_CHARS + 500)
    await writeFile(join(evidenceRoot, STORE, 'r1', 'long.log'), `prefix\n${longLine}`)
    const charTail = await registry.logTail(`${STORE}/r1/long.log`)
    expect(charTail).toBeDefined()
    expect(charTail!.length).toBe(LOG_TAIL_MAX_CHARS)
    expect(charTail).not.toContain('prefix')
  })

  test('missing logs and escapes resolve to undefined or a loud error, never a crash', async () => {
    const { registry } = await setup({ task: task([]) })
    expect(await registry.logTail(`${STORE}/r1/nope.log`)).toBeUndefined()
    await expect(registry.logTail('../escape.log')).rejects.toThrow('escapes evidenceRoot')
  })
})

describe('VerifierRegistry metadata and selftest (KISS §4.3, VRTC plan 2.2)', () => {
  test('the three built-ins register with version, owner, and selftest — construction logs no warning', async () => {
    const { registry, warnings } = await setup({ task: task([]) })
    expect(warnings).toEqual([])
    expect(registry.verifierIds()).toEqual(['command', 'composite', 'review'])
  })

  test('a registration without a selftest is warned, not refused', async () => {
    const { registry, warnings } = await setup({ task: task([criterion()]) })
    const custom: Verifier = {
      id: 'custom-command',
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'pass' as const, verifierId: 'custom-command' })),
    }
    registry.register(custom)
    expect(warnings).toEqual(['verifier "custom-command" registered without a selftest (no declared positive/negative known samples)'])
    expect(registry.verifierIds()).toContain('custom-command')
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]!.verifierId).toBe('custom-command')
  })

  test('a registration carrying a selftest logs no warning', async () => {
    const { registry, warnings } = await setup({ task: task([criterion()]) })
    const custom: Verifier = {
      id: 'self-tested',
      version: '1',
      owner: 'tests',
      selftest: { positiveCases: ['known-good'], negativeCases: ['known-bad'] },
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'pass' as const, verifierId: 'self-tested' })),
    }
    registry.register(custom)
    expect(warnings).toEqual([])
    expect(registry.verifierIds()).toContain('self-tested')
  })

  test('the review verifier never auto-passes its declared positive sample', async () => {
    const verifier = new ReviewVerifier()
    const [result] = await verifier.verify({
      taskId: 't1',
      runId: 'r1',
      criteria: [criterion({ verificationMode: 'review', command: undefined })],
      cwd: '',
      logDir: '',
    })
    expect(result!.status).toBe('inconclusive')
  })
})

describe('VerifierRegistry verifierRef dispatch (KISS §4.1, VRTC plan 1.4)', () => {
  test.each([
    ['no verdict', []],
    ['non-array', null],
    ['duplicate verdicts', [
      { criterionId: 'c1', verifierId: 'broken', status: 'pass' },
      { criterionId: 'c1', verifierId: 'broken', status: 'fail' },
    ]],
    ['wrong criterion', [{ criterionId: 'other', verifierId: 'broken', status: 'pass' }]],
    ['forged verifier', [{ criterionId: 'c1', verifierId: 'command', status: 'pass' }]],
    ['unknown status', [{ criterionId: 'c1', verifierId: 'broken', status: 'success' }]],
    ['unknown pass', [{ criterionId: 'c1', verifierId: 'broken', status: 'pass', unknownKind: 'task' }]],
  ])('malformed plugin output (%s) produces verifier UNKNOWN, never a pass', async (_label, output) => {
    const { registry } = await setup({ task: task([criterion({ verifierRef: 'broken' })]) })
    registry.register({ id: 'broken', supports: () => true, verify: async () => output as VerificationResult[] })
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults).toHaveLength(1)
    expect(bundle.verifierResults[0]).toMatchObject({
      criterionId: 'c1', verifierId: 'broken', status: 'inconclusive', unknownKind: 'verifier',
    })
    expect(bundle.claims[0]).toMatchObject({ status: 'inconclusive', unknownKind: 'verifier' })
  })

  test('a criterion with verifierRef dispatches to that verifier, not the mode winner', async () => {
    // The task pins the built-in 'command' while a later registration also
    // supports the mode — mode dispatch would pick the later one, so only the
    // ref can explain a 'command' verdict.
    const { registry } = await setup({ task: task([criterion({ verifierRef: 'command' })]) })
    const custom: Verifier = {
      id: 'custom-command',
      selftest: { positiveCases: ['known-good'], negativeCases: ['known-bad'] },
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'fail' as const, verifierId: 'custom-command' })),
    }
    registry.register(custom)
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]!.verifierId).toBe('command')
    expect(bundle.verifierResults[0]!.status).toBe('pass')
  })

  test('an unknown verifierRef settles inconclusive as a verifier-side unknown', async () => {
    const { registry } = await setup({ task: task([criterion({ verifierRef: 'ghost' })]) })
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]).toEqual({
      criterionId: 'c1',
      status: 'inconclusive',
      verifierId: 'ghost',
      details: 'no verifier registered with id "ghost"',
      unknownKind: 'verifier',
    })
    // The claim carries the kind too, so a reader never reopens the result.
    expect(bundle.claims[0]!.unknownKind).toBe('verifier')
  })

  test('a pinned verifier that does not support the mode settles inconclusive as a verifier-side unknown', async () => {
    const { registry } = await setup({
      task: task([criterion({ verifierRef: 'review' })]),
    })
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]).toEqual({
      criterionId: 'c1',
      status: 'inconclusive',
      verifierId: 'review',
      details: 'verifier "review" does not support mode "deterministic"',
      unknownKind: 'verifier',
    })
  })

  test('a verifier that throws settles inconclusive as a verifier-side unknown', async () => {
    const { registry } = await setup({ task: task([criterion({ verifierRef: 'broken' })]) })
    const broken: Verifier = {
      id: 'broken',
      selftest: { positiveCases: [], negativeCases: [] },
      supports: mode => mode === 'deterministic',
      verify: async () => { throw new Error('judge exploded') },
    }
    registry.register(broken)
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]).toEqual({
      criterionId: 'c1',
      status: 'inconclusive',
      verifierId: 'broken',
      details: 'judge exploded',
      unknownKind: 'verifier',
    })
    expect(bundle.claims[0]!.unknownKind).toBe('verifier')
  })
})
