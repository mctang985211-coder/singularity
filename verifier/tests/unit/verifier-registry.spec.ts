import { mkdtemp, readFile } from 'node:fs/promises'
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
import { VerifierRegistry } from '../../src/index.ts'

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
  }
  return { ctx, taskService, recorded }
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
