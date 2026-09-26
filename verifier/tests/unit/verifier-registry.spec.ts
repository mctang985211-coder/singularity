import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type {
  AcceptanceCriterion,
  EvidenceBundle,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
  VerificationResult,
} from '../../../task/src/types.ts'
import type { Verifier, VerifyRequest } from '../../src/types.ts'
import { LOG_TAIL_MAX_CHARS, LOG_TAIL_MAX_LINES, ReviewVerifier, VerifierRegistry } from '../../src/index.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const STORE = 'sg-t-root-session'

/**
 * The digest the admission side fixes, computed here independently of the code
 * under test: SHA-256 of the file's bytes, lowercase hex.
 */
function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

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

function emptySnapshot(evidence: EvidenceBundle[]): TaskSnapshot {
  return {
    version: 1,
    id: STORE,
    tasks: [],
    runs: [],
    edges: [],
    evidence,
    handoffs: [],
    reviews: [],
    diagnoses: [],
    obligations: [],
    capabilities: {},
  }
}


/** A judge whose verdicts the test dictates; registered through the explicit test-double channel. */
function testDouble(id: string, verify: Verifier['verify'], overrides: Partial<Verifier> = {}): Verifier {
  return { id, supports: mode => mode === 'deterministic', verify, ...overrides }
}

function harness(options: { task: TaskInstance; run?: TaskRun; members?: TaskInstance[]; evidence?: EvidenceBundle[] }) {
  const recorded: EvidenceBundle[] = []
  const warnings: string[] = []
  const taskService = {
    runIn: vi.fn(async (_storeId: string, runId: string) => ({ ...(options.run ?? run()), runId })),
    taskIn: vi.fn(async () => options.task),
    runMembersIn: vi.fn(async () => options.members ?? []),
    snapshotIn: vi.fn(async () => emptySnapshot(options.evidence ?? [...recorded])),
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

async function setup(
  options: { task: TaskInstance; run?: TaskRun; members?: TaskInstance[]; evidence?: EvidenceBundle[] },
  extra: { ready?: boolean } = {},
) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'verifier-registry-'))
  const cwd = await mkdtemp(join(tmpdir(), 'verifier-run-'))
  const h = harness(options)
  const registry = new VerifierRegistry(h.ctx as never, { evidenceRoot })
  if (extra.ready !== false) await registry.ready()
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
      members: [
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
    await registry.register(custom, { testDouble: true })
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
    const dispose = await registry.register(replacement, { testDouble: true })
    expect((await registry.verifyRun(STORE, 'r1')).verifierResults[0]!.verifierId).toBe('review-2')
    dispose()
    expect((await registry.verifyRun(STORE, 'r1')).verifierResults[0]!.verifierId).toBe('review')
    await registry.register(replacement, { testDouble: true })
    await expect(registry.register(replacement, { testDouble: true })).rejects.toThrow('duplicate verifier')
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
    await registry.register(absolute, { testDouble: true })
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
    await registry.register(escaping, { testDouble: true })
    await expect(registry.verifyRun(STORE, 'r1')).rejects.toThrow('escapes evidenceRoot')
  })

  test('composite criteria fail through the registry when a child is unverified', async () => {
    const { registry } = await setup({
      task: task([criterion({ criterionId: 'cmp', verificationMode: 'composite', command: undefined })]),
      members: [{ ...task([], { taskId: 'c1', status: 'running', depth: 1 }) }],
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

describe('VerifierRegistry ready() and the executable selftest gate (V2-1/V2-2, KISS §4.3)', () => {
  test('before ready() the registry holds no verifiers, and verifyRun readies it before dispatching', async () => {
    const { registry, cwd } = await setup({ task: task([criterion()]) }, { ready: false })
    expect(registry.verifierIds()).toEqual([])
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    expect(bundle.verifierResults[0]!.verifierId).toBe('command')
    expect(bundle.verifierResults[0]!.status).toBe('pass')
  })

  test('the three built-ins register through the gate in ready(), whose samples really executed', async () => {
    const { registry, warnings, evidenceRoot } = await setup({ task: task([]) })
    // No test-double channel was taken for a built-in: that channel warns.
    expect(warnings).toEqual([])
    expect(registry.verifierIds()).toEqual(['command', 'composite', 'review'])
    // The gate executed the command verifier's samples for real: its scratch
    // cwd exists and the first sample's shell run left a log behind.
    expect((await stat(join(evidenceRoot, 'selftest', 'cwd'))).isDirectory()).toBe(true)
    const sampleLogs = await readdir(join(evidenceRoot, 'selftest', 'command', '0'))
    expect(sampleLogs.some(name => name.endsWith('.log'))).toBe(true)
  })

  test('ready() is idempotent: repeated calls register nothing twice and warn nothing', async () => {
    const { registry, warnings } = await setup({ task: task([]) })
    await registry.ready()
    await registry.ready()
    expect(registry.verifierIds()).toEqual(['command', 'composite', 'review'])
    expect(warnings).toEqual([])
  })

  test('a registration with an executable selftest it passes registers, with no warning', async () => {
    const { registry, warnings } = await setup({ task: task([criterion({ verifierRef: 'self-tested' })]) })
    const selfTested: Verifier = {
      id: 'self-tested',
      version: '1',
      owner: 'tests',
      selftest: {
        samples: [
          { role: 'positive', name: 'known-good', criterion: criterion({ criterionId: 'selftest-good', command: 'true' }), expect: 'pass' },
          { role: 'negative', name: 'known-bad', criterion: criterion({ criterionId: 'selftest-bad', command: 'false' }), expect: 'fail' },
        ],
      },
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({
        criterionId: c.criterionId,
        status: c.command === 'true' ? 'pass' as const : 'fail' as const,
        verifierId: 'self-tested',
      })),
    }
    await registry.register(selfTested)
    expect(warnings).toEqual([])
    expect(registry.verifierIds()).toContain('self-tested')
  })

  test('a judge that misses its own negative sample is refused, naming the sample and the verdict it returned', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const alwaysPass: Verifier = {
      id: 'always-pass',
      selftest: {
        samples: [
          { role: 'positive', name: 'known-good command', criterion: criterion({ criterionId: 'selftest-good', command: 'true' }), expect: 'pass' },
          { role: 'negative', name: 'known-bad command', criterion: criterion({ criterionId: 'selftest-bad', command: 'false' }), expect: 'fail' },
        ],
      },
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({
        criterionId: c.criterionId,
        status: 'pass' as const,
        verifierId: 'always-pass',
      })),
    }
    const failure = await registry.register(alwaysPass).then(() => undefined, (error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure!.message).toContain('verifier "always-pass" selftest failed')
    expect(failure!.message).toContain('sample "known-bad command" (role negative) expected "fail" but the judge returned "pass"')
    expect(registry.verifierIds()).not.toContain('always-pass')
  })

  test('a judge whose positive sample is not accepted is refused', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const alwaysFail: Verifier = {
      id: 'always-fail',
      selftest: {
        samples: [
          { role: 'positive', name: 'known-good command', criterion: criterion({ criterionId: 'selftest-good', command: 'true' }), expect: 'pass' },
          { role: 'negative', name: 'known-bad command', criterion: criterion({ criterionId: 'selftest-bad', command: 'false' }), expect: 'fail' },
        ],
      },
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({
        criterionId: c.criterionId,
        status: 'fail' as const,
        verifierId: 'always-fail',
      })),
    }
    const failure = await registry.register(alwaysFail).then(() => undefined, (error: Error) => error)
    expect(failure!.message).toContain('sample "known-good command" (role positive) expected "pass" but the judge returned "fail"')
    expect(registry.verifierIds()).not.toContain('always-fail')
  })

  test('a judge whose sample output the production validation rejects is refused with that reason', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const duplicated: Verifier = {
      id: 'duplicated-results',
      selftest: {
        samples: [
          { role: 'positive', name: 'known-good command', criterion: criterion({ criterionId: 'selftest-good', command: 'true' }), expect: 'pass' },
          { role: 'negative', name: 'known-bad command', criterion: criterion({ criterionId: 'selftest-bad', command: 'false' }), expect: 'fail' },
        ],
      },
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.flatMap(c => [
        { criterionId: c.criterionId, status: 'pass' as const, verifierId: 'duplicated-results' },
        { criterionId: c.criterionId, status: 'fail' as const, verifierId: 'duplicated-results' },
      ]),
    }
    const failure = await registry.register(duplicated).then(() => undefined, (error: Error) => error)
    expect(failure!.message).toContain('sample "known-good command" (role positive) produced no valid result')
    expect(failure!.message).toContain('must return exactly one valid result for criterion "selftest-good"')
    expect(registry.verifierIds()).not.toContain('duplicated-results')
  })

  test('a judge that throws on a sample is refused with the thrown reason', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const broken: Verifier = {
      id: 'broken-samples',
      selftest: {
        samples: [
          { role: 'positive', name: 'known-good command', criterion: criterion({ criterionId: 'selftest-good', command: 'true' }), expect: 'pass' },
          { role: 'negative', name: 'known-bad command', criterion: criterion({ criterionId: 'selftest-bad', command: 'false' }), expect: 'fail' },
        ],
      },
      supports: mode => mode === 'deterministic',
      verify: async () => { throw new Error('sample exploded') },
    }
    const failure = await registry.register(broken).then(() => undefined, (error: Error) => error)
    expect(failure!.message).toContain('sample "known-good command" (role positive) threw: sample exploded')
    expect(registry.verifierIds()).not.toContain('broken-samples')
  })

  test('a registration without executable selftest samples is refused, never warned through', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const undescribed = testDouble('undescribed', async req => req.criteria.map(c => ({
      criterionId: c.criterionId,
      status: 'pass' as const,
      verifierId: 'undescribed',
    })))
    await expect(registry.register(undescribed)).rejects.toThrow(
      'verifier "undescribed" cannot be registered: no executable selftest samples (KISS §4.3)',
    )
    expect(registry.verifierIds()).not.toContain('undescribed')
  })

  test('a descriptive selftest is refused, never inferred to be a test double', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const descriptive = {
      id: 'descriptive',
      selftest: { positiveCases: ['true'], negativeCases: ['false'] },
      supports: () => true,
      verify: async (req: VerifyRequest) => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'pass' as const, verifierId: 'descriptive' })),
    } as unknown as Verifier
    const failure = await registry.register(descriptive).then(() => undefined, (error: Error) => error)
    expect(failure!.message).toContain('verifier "descriptive" cannot be registered')
    expect(failure!.message).toContain('selftest.samples must be a non-empty array (got undefined)')
    expect(registry.verifierIds()).not.toContain('descriptive')
  })

  test('malformed sample shapes are refused together, before any sample executes', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const verify = vi.fn(async (req: VerifyRequest) => req.criteria.map(c => ({
      criterionId: c.criterionId,
      status: 'pass' as const,
      verifierId: 'malformed',
    })))
    const malformed = {
      id: 'malformed',
      selftest: {
        samples: [
          { role: 'positive', name: '   ', criterion: criterion({ criterionId: 'selftest-good', command: 'true' }), expect: 'pass' },
          { role: 'negative', name: 'no criterion', expect: 'fail' },
          { role: 'negative', name: 'passed negative', criterion: criterion({ criterionId: 'selftest-bad', command: 'false' }), expect: 'pass' },
        ],
      },
      supports: () => true,
      verify,
    } as unknown as Verifier
    const failure = await registry.register(malformed).then(() => undefined, (error: Error) => error)
    expect(failure!.message).toContain('verifier "malformed" cannot be registered')
    expect(failure!.message).toContain('sample #0 has no name')
    expect(failure!.message).toContain('sample "no criterion" has no criterion carrying a criterionId')
    expect(failure!.message).toContain('sample "passed negative" (role negative) must expect "fail" or "not-pass" (got "pass")')
    expect(verify).not.toHaveBeenCalled()
    expect(registry.verifierIds()).not.toContain('malformed')
  })

  test('a selftest declaring samples on only one side is refused', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const good = { role: 'positive' as const, name: 'known-good', criterion: criterion({ criterionId: 'selftest-good', command: 'true' }), expect: 'pass' as const }
    const bad = { role: 'negative' as const, name: 'known-bad', criterion: criterion({ criterionId: 'selftest-bad', command: 'false' }), expect: 'fail' as const }
    const verify = async (req: VerifyRequest) => req.criteria.map(c => ({
      criterionId: c.criterionId,
      status: 'pass' as const,
      verifierId: 'one-sided',
    }))
    const positivesOnly = await registry
      .register({ id: 'one-sided', selftest: { samples: [good] }, supports: () => true, verify })
      .then(() => undefined, (error: Error) => error)
    expect(positivesOnly!.message).toContain('no sample declares role "negative"')
    const negativesOnly = await registry
      .register({ id: 'other-sided', selftest: { samples: [bad] }, supports: () => true, verify })
      .then(() => undefined, (error: Error) => error)
    expect(negativesOnly!.message).toContain('no sample declares role "positive"')
    expect(registry.verifierIds()).not.toContain('one-sided')
    expect(registry.verifierIds()).not.toContain('other-sided')
  })

  test('an empty samples declaration is refused, naming what was declared', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const verify = async (req: VerifyRequest) => req.criteria.map(c => ({
      criterionId: c.criterionId,
      status: 'pass' as const,
      verifierId: 'empty',
    }))
    const empty = await registry
      .register({ id: 'empty', selftest: { samples: [] }, supports: () => true, verify })
      .then(() => undefined, (error: Error) => error)
    expect(empty!.message).toContain('selftest.samples must be a non-empty array (got an empty array)')
  })

  test('a store-reading sample is refused for a judge the registry cannot execute it against', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const storeReader: Verifier = {
      id: 'store-reader',
      selftest: {
        samples: [
          { role: 'positive', name: 'with a store view', criterion: criterion({ criterionId: 'selftest-store', verificationMode: 'composite' }), expect: 'pass', store: { children: [] } },
          { role: 'negative', name: 'known-bad', criterion: criterion({ criterionId: 'selftest-bad', command: 'false' }), expect: 'fail' },
        ],
      },
      supports: () => true,
      verify: async req => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'pass' as const, verifierId: 'store-reader' })),
    }
    const failure = await registry.register(storeReader).then(() => undefined, (error: Error) => error)
    expect(failure!.message).toContain('sample "with a store view" declares a store view, which only the registry\'s composite judge can execute')
    expect(registry.verifierIds()).not.toContain('store-reader')
  })
})

describe('VerifierRegistry test-double channel (V2-2)', () => {
  test('an explicit test-double registration skips the gate and warns that it did', async () => {
    const { registry, warnings } = await setup({ task: task([criterion()]) })
    const double: Verifier = {
      id: 'plain-double',
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'pass' as const, verifierId: 'plain-double' })),
    }
    await registry.register(double, { testDouble: true })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('plain-double')
    expect(warnings[0]).toContain('test double')
    expect(warnings[0]).toContain('selftest gate')
    expect(registry.verifierIds()).toContain('plain-double')
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]!.verifierId).toBe('plain-double')
  })

  test('only the explicit literal true opens the channel; any other value takes the gate', async () => {
    const { registry } = await setup({ task: task([criterion()]) })
    const double: Verifier = {
      id: 'truthy-double',
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'pass' as const, verifierId: 'truthy-double' })),
    }
    await expect(registry.register(double, { testDouble: 'yes' } as never)).rejects.toThrow('no executable selftest samples')
    expect(registry.verifierIds()).not.toContain('truthy-double')
  })
})

describe('VerifierRegistry metadata and selftest (KISS §4.3, VRTC plan 2.2)', () => {
  test('the three built-ins register with version, owner, and selftest — ready() logs no warning', async () => {
    const { registry, warnings } = await setup({ task: task([]) })
    expect(warnings).toEqual([])
    expect(registry.verifierIds()).toEqual(['command', 'composite', 'review'])
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

  test('both of the review verifier\'s declared samples come back not-pass when executed', async () => {
    const verifier = new ReviewVerifier()
    expect(verifier.selftest.samples.map(sample => sample.expect)).toEqual(['not-pass', 'not-pass'])
    for (const sample of verifier.selftest.samples) {
      const [result] = await verifier.verify({ taskId: 't1', runId: 'r1', criteria: [sample.criterion], cwd: '', logDir: '' })
      expect(result!.status, `sample "${sample.name}"`).not.toBe('pass')
    }
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
    await registry.register({ id: 'broken', supports: () => true, verify: async () => output as VerificationResult[] }, { testDouble: true })
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
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(c => ({ criterionId: c.criterionId, status: 'fail' as const, verifierId: 'custom-command' })),
    }
    await registry.register(custom, { testDouble: true })
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
      supports: mode => mode === 'deterministic',
      verify: async () => { throw new Error('judge exploded') },
    }
    await registry.register(broken, { testDouble: true })
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

describe('VerifierRegistry verifier version identity (V2-3, KISS §8.2)', () => {
  test('a verdict and its claim carry the registered instance version, never the plugin self-report', async () => {
    const { registry } = await setup({ task: task([criterion({ verifierRef: 'versioned' })]) })
    const forged: Verifier = testDouble('versioned', async req => req.criteria.map(c => ({
      criterionId: c.criterionId,
      status: 'pass' as const,
      verifierId: 'versioned',
      verifierVersion: 'forged-9',
    })), { version: '2' })
    await registry.register(forged, { testDouble: true })
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]!.verifierVersion).toBe('2')
    expect(bundle.claims[0]!.verifierVersion).toBe('2')
  })

  test('an instance that declares no version stamps none, removing a forged one', async () => {
    const { registry } = await setup({ task: task([criterion({ verifierRef: 'versionless' })]) })
    const forged: Verifier = testDouble('versionless', async req => req.criteria.map(c => ({
      criterionId: c.criterionId,
      status: 'pass' as const,
      verifierId: 'versionless',
      verifierVersion: 'forged-9',
    })))
    await registry.register(forged, { testDouble: true })
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(bundle.verifierResults[0]).not.toHaveProperty('verifierVersion')
    expect(bundle.claims[0]).not.toHaveProperty('verifierVersion')
  })

  test('a built-in verdict carries the built-in instance version', async () => {
    const { registry, cwd } = await setup({ task: task([criterion()]) })
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    expect(bundle.verifierResults[0]!.verifierVersion).toBe('1')
    expect(bundle.claims[0]!.verifierVersion).toBe('1')
  })
})

describe('VerifierRegistry protected acceptance inputs (V2-4)', () => {
  const ACCEPTANCE = 'acceptance.sh'
  const ADMITTED = 'exit 0\n'

  /** A judge whose dispatch the malformed-entry tests can assert never happened. */
  function spyJudge(id: string) {
    return vi.fn(async (req: VerifyRequest) => req.criteria.map(c => ({
      criterionId: c.criterionId,
      status: 'pass' as const,
      verifierId: id,
    })))
  }

  test('a malformed protected input entry yields a readable fail, never a crash', async () => {
    const judge = spyJudge('spy-judge')
    const { registry } = await setup({
      task: task([criterion({
        verifierRef: 'spy-judge',
        protectedInputs: [{ path: undefined, sha256: 'x' } as never],
      })]),
    })
    await registry.register(testDouble('spy-judge', judge), { testDouble: true })
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(judge).not.toHaveBeenCalled()
    const result = bundle.verifierResults[0]!
    expect(result).toMatchObject({ criterionId: 'c1', status: 'fail', verifierId: 'spy-judge' })
    expect(result.details).toContain('protected input entry 0 is malformed: path must be a non-empty string')
    expect(result.unknownKind).toBeUndefined()
  })

  test('a non-object entry and a non-string digest are named, not thrown', async () => {
    const judge = spyJudge('spy-judge')
    const { registry } = await setup({
      task: task([
        criterion({ criterionId: 'not-object', verifierRef: 'spy-judge', protectedInputs: [ACCEPTANCE as never] }),
        criterion({ criterionId: 'bad-digest', verifierRef: 'spy-judge', protectedInputs: [{ path: ACCEPTANCE, sha256: 7 } as never] }),
      ]),
    })
    await registry.register(testDouble('spy-judge', judge), { testDouble: true })
    const bundle = await registry.verifyRun(STORE, 'r1')
    expect(judge).not.toHaveBeenCalled()
    expect(bundle.verifierResults.map(result => [result.criterionId, result.status])).toEqual([
      ['not-object', 'fail'],
      ['bad-digest', 'fail'],
    ])
    expect(bundle.verifierResults[0]!.details).toContain('protected input entry 0 is malformed: expected an object with a path and a sha256')
    expect(bundle.verifierResults[1]!.details).toContain('protected input entry 0 is malformed: sha256 must be a non-empty string')
  })

  test('a modified protected input refuses the verdict with a fail naming the path and both digests', async () => {
    const { registry, cwd } = await setup({ task: task([criterion({ protectedInputs: [{ path: ACCEPTANCE, sha256: sha256(ADMITTED) }] })]) })
    await writeFile(join(cwd, ACCEPTANCE), 'exit 0  # rewritten after admission\n')
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    const result = bundle.verifierResults[0]!
    expect(result.status).toBe('fail')
    expect(result.criterionId).toBe('c1')
    expect(result.details).toContain(`protected input "${ACCEPTANCE}" changed since admission`)
    expect(result.details).toContain(`admitted sha256 ${sha256(ADMITTED)}`)
    expect(result.details).toContain(sha256('exit 0  # rewritten after admission\n'))
    expect(result.unknownKind).toBeUndefined()
    expect(bundle.claims[0]).toMatchObject({ status: 'fail', verifierId: 'command' })
  })

  test('a missing protected input refuses the verdict, naming the path', async () => {
    const { registry, cwd } = await setup({ task: task([criterion({ protectedInputs: [{ path: 'gone.sh', sha256: sha256(ADMITTED) }] })]) })
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    expect(bundle.verifierResults[0]).toMatchObject({ criterionId: 'c1', status: 'fail', verifierId: 'command' })
    expect(bundle.verifierResults[0]!.details).toContain('protected input "gone.sh" is missing or unreadable')
    expect(bundle.verifierResults[0]!.unknownKind).toBeUndefined()
  })

  test('an unmodified protected input leaves the judgement to the verifier', async () => {
    const { registry, cwd } = await setup({
      task: task([criterion({
        command: 'true',
        protectedInputs: [{ path: ACCEPTANCE, sha256: sha256(ADMITTED) }],
      })]),
    })
    await writeFile(join(cwd, ACCEPTANCE), ADMITTED)
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    expect(bundle.verifierResults[0]).toMatchObject({ criterionId: 'c1', status: 'pass', verifierId: 'command' })
  })

  test('a refused protected input never spawns the criterion command', async () => {
    const marker = 'spawned-marker'
    const { registry, cwd } = await setup({
      task: task([criterion({
        command: `touch ${marker}`,
        protectedInputs: [{ path: ACCEPTANCE, sha256: sha256(ADMITTED) }],
      })]),
    })
    await writeFile(join(cwd, ACCEPTANCE), 'exit 7\n')
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    expect(bundle.verifierResults[0]!.status).toBe('fail')
    expect(bundle.verifierResults[0]!.details).toContain('changed since admission')
    await expect(stat(join(cwd, marker))).rejects.toThrow()
  })

  test('every declared input is checked: one refusal names each defect, not just the first', async () => {
    const { registry, cwd } = await setup({
      task: task([criterion({
        protectedInputs: [
          { path: ACCEPTANCE, sha256: sha256(ADMITTED) },
          { path: 'thresholds.json', sha256: sha256('{"max": 1}') },
        ],
      })]),
    })
    await writeFile(join(cwd, ACCEPTANCE), 'exit 0  # rewritten after admission\n')
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    const result = bundle.verifierResults[0]!
    expect(result.status).toBe('fail')
    expect(result.details).toContain(`protected input "${ACCEPTANCE}" changed since admission`)
    expect(result.details).toContain('protected input "thresholds.json" is missing or unreadable')
  })

  test('a criterion that declares no protected inputs is not protected', async () => {
    const { registry, cwd } = await setup({
      task: task([
        criterion({ criterionId: 'undeclared', command: 'true' }),
        criterion({ criterionId: 'empty', command: 'true', protectedInputs: [] }),
      ]),
    })
    // The same file a declared criterion would refuse is irrelevant here: only
    // declared paths are protected, and the digest is never guessed.
    await writeFile(join(cwd, ACCEPTANCE), 'exit 0  # rewritten after admission\n')
    const bundle = await registry.verifyRun(STORE, 'r1', { cwd })
    expect(bundle.verifierResults.map(result => [result.criterionId, result.status])).toEqual([
      ['undeclared', 'pass'],
      ['empty', 'pass'],
    ])
  })
})
