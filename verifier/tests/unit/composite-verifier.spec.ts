import { describe, expect, test, vi } from 'vitest'
import type { AcceptanceCriterion, EvidenceBundle, TaskInstance, TaskRun, TaskSnapshot, VerificationResult } from '../../../task/src/types.ts'
import type { VerifyRequest } from '../../src/types.ts'
import { CompositeVerifier, judgeCompositeCriterion } from '../../src/composite-verifier.ts'

const NOW = '2026-09-16T00:00:00.000Z'

function criterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    criterionId: 'root-children-verified',
    description: 'all mandatory children verified',
    verificationMode: 'composite',
    requiredEvidence: [],
    mandatory: true,
    ...overrides,
  }
}

function child(taskId: string, status: TaskInstance['status'], criteria: AcceptanceCriterion[] = []): TaskInstance {
  return {
    taskId,
    definitionRef: { taskType: 'build', version: 1 },
    parentTaskId: 'root',
    objective: 'child work',
    depth: 1,
    acceptanceCriteria: criteria,
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status,
    runIds: [],
    childTaskIds: [],
  }
}

function run(runId: string, taskId: string, status: TaskRun['status']): TaskRun {
  return {
    runId,
    taskId,
    sessionId: `s-${runId}`,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status,
    startedAt: NOW,
  }
}

function verdict(criterionId: string, status: VerificationResult['status']): VerificationResult {
  return { criterionId, status, verifierId: 'fake-verifier' }
}

function bundle(evidenceId: string, taskRunId: string, taskId: string, verifierResults: VerificationResult[], artifacts: EvidenceBundle['artifacts'] = []): EvidenceBundle {
  return {
    evidenceId,
    taskRunId,
    taskId,
    artifacts,
    verifierResults,
    claims: verifierResults.map(item => ({
      claimId: `${evidenceId}#${item.criterionId}`,
      criterionId: item.criterionId,
      status: item.status,
      verifierId: item.verifierId,
      artifactRefs: [],
    })),
    generatedAt: NOW,
  }
}

function snapshot(children: TaskInstance[], runs: TaskRun[], evidence: EvidenceBundle[]): TaskSnapshot {
  return {
    version: 1,
    id: 'sg-t-root',
    tasks: children,
    runs,
    edges: [],
    evidence,
    handoffs: [],
    reviews: [],
    diagnoses: [],
    obligations: [],
    capabilities: {},
  }
}

function request(criteria: AcceptanceCriterion[] = [criterion()]): VerifyRequest {
  return { taskId: 'root', runId: 'r1', criteria, cwd: '/unused', logDir: '/unused' }
}

function source(children: TaskInstance[], runs: TaskRun[] = [], evidence: EvidenceBundle[] = []) {
  return {
    childrenIn: vi.fn(async (_storeId: string, _taskId: string) => children),
    snapshotIn: vi.fn(async (_storeId: string) => snapshot(children, runs, evidence)),
  }
}

describe('CompositeVerifier', () => {
  test('supports composite mode only', () => {
    const verifier = new CompositeVerifier(source([]))
    expect(verifier.supports('composite')).toBe(true)
    expect(verifier.supports('deterministic')).toBe(false)
  })

  test('passes when every child is verified', async () => {
    const childrenIn = source([child('c1', 'verified'), child('c2', 'verified')])
    const verifier = new CompositeVerifier(childrenIn)
    const [result] = await verifier.verifyIn('sg-t-root', request())
    expect(result.status).toBe('pass')
    expect(result.verifierId).toBe('composite')
    expect(childrenIn.childrenIn).toHaveBeenCalledWith('sg-t-root', 'root')
  })

  test('fails when any child is not verified, naming the stragglers', async () => {
    const verifier = new CompositeVerifier(source([child('c1', 'verified'), child('c2', 'running'), child('c3', 'failed')]))
    const [result] = await verifier.verifyIn('sg-t-root', request())
    expect(result.status).toBe('fail')
    expect(result.details).toContain('c2(running)')
    expect(result.details).toContain('c3(failed)')
    expect(result.details).not.toContain('c1')
  })

  test('no children is inconclusive', async () => {
    const verifier = new CompositeVerifier(source([]))
    const [result] = await verifier.verifyIn('sg-t-root', request())
    expect(result.status).toBe('inconclusive')
    expect(result.details).toBe('no child tasks')
  })

  test('plain verify without store context stays inconclusive', async () => {
    const verifier = new CompositeVerifier(source([child('c1', 'verified')]))
    const [result] = await verifier.verify(request())
    expect(result.status).toBe('inconclusive')
    expect(result.details).toContain('store context')
  })
})

describe('CompositeVerifier parent evidence map (P4, KISS §6 C2)', () => {
  test('P4-A: a complete childEvidence map over verified children passes and names what was checked', async () => {
    const children = [
      child('c1', 'verified', [criterion({ criterionId: 'ac1-1', verificationMode: 'deterministic', command: 'true' })]),
      child('c2', 'verified', [criterion({ criterionId: 'ac2-1', verificationMode: 'deterministic', command: 'true' })]),
    ]
    const runs = [run('r-c1', 'c1', 'verified'), run('r-c2', 'c2', 'verified')]
    const evidence = [
      bundle('e-c1', 'r-c1', 'c1', [verdict('ac1-1', 'pass')], [{ artifactId: 'a-trace', kind: 'bemu_trace', uri: 'traces/bemu.jsonl' }]),
      bundle('e-c2', 'r-c2', 'c2', [verdict('ac2-1', 'pass')]),
    ]
    const verifier = new CompositeVerifier(source(children, runs, evidence))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({
      childEvidence: [
        { childIndex: 0, criterionId: 'ac1-1' },
        { childIndex: 1, evidenceRef: 'e-c2' },
        { childIndex: 1 },
      ],
    })]))
    expect(result.status).toBe('pass')
    expect(result.details).toContain('child #0 (c1) criterion "ac1-1" passed')
    expect(result.details).toContain('child #1 (c2) evidence "e-c2" present')
    expect(result.details).toContain('child #1 (c2) verified')
  })

  test('P4-A: an evidenceRef is satisfied by artifact kind and artifact id spellings of the verified run', async () => {
    const children = [child('c1', 'verified', [])]
    const runs = [run('r-c1', 'c1', 'verified')]
    const evidence = [bundle('e-c1', 'r-c1', 'c1', [], [{ artifactId: 'a-trace', kind: 'bemu_trace', uri: 'traces/bemu.jsonl' }])]
    const verifier = new CompositeVerifier(source(children, runs, evidence))
    for (const ref of ['bemu_trace', 'a-trace', 'e-c1']) {
      const [result] = await verifier.verifyIn('sg-t-root', request([criterion({ childEvidence: [{ childIndex: 0, evidenceRef: ref }] })]))
      expect(result.status, ref).toBe('pass')
    }
  })

  test('P4-B: a map pointing at a criterion the child does not have fails, naming the missing item', async () => {
    const children = [child('c1', 'verified', [criterion({ criterionId: 'ac1-1', verificationMode: 'deterministic', command: 'true' })])]
    const runs = [run('r-c1', 'c1', 'verified')]
    const evidence = [bundle('e-c1', 'r-c1', 'c1', [verdict('ac1-1', 'pass')])]
    const verifier = new CompositeVerifier(source(children, runs, evidence))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({ childEvidence: [{ childIndex: 0, criterionId: 'ac1-9' }] })]))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('ac1-9')
    expect(result.details).toContain('child #0 (c1) has no criterion')
  })

  test('P4-B: a map pointing at an evidence ref the child never produced fails, naming the missing item', async () => {
    const children = [child('c1', 'verified', [])]
    const runs = [run('r-c1', 'c1', 'verified')]
    const evidence = [bundle('e-c1', 'r-c1', 'c1', [], [{ artifactId: 'a-trace', kind: 'bemu_trace', uri: 'traces/bemu.jsonl' }])]
    const verifier = new CompositeVerifier(source(children, runs, evidence))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({ childEvidence: [{ childIndex: 0, evidenceRef: 'verilator_trace' }] })]))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('verilator_trace')
    expect(result.details).toContain('child #0 (c1) evidence does not contain')
  })

  test('P4-B: a map pointing past the batch and at every missing entry names each one', async () => {
    const children = [child('c1', 'verified', [])]
    const runs = [run('r-c1', 'c1', 'verified')]
    const evidence = [bundle('e-c1', 'r-c1', 'c1', [])]
    const verifier = new CompositeVerifier(source(children, runs, evidence))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({
      childEvidence: [
        { childIndex: 2 },
        { childIndex: 0, criterionId: 'ac1-7' },
      ],
    })]))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('child #2 does not exist')
    expect(result.details).toContain('ac1-7')
  })

  test('P4-B: a criterion without a passing verdict in the verified run evidence fails the map', async () => {
    const children = [child('c1', 'verified', [criterion({ criterionId: 'ac1-1', verificationMode: 'deterministic', command: 'true' })])]
    const runs = [run('r-c1', 'c1', 'verified')]
    const evidence = [bundle('e-c1', 'r-c1', 'c1', [verdict('ac1-1', 'inconclusive')])]
    const verifier = new CompositeVerifier(source(children, runs, evidence))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({ childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }] })]))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('ac1-1')
    expect(result.details).toContain('no passing verdict')
  })

  test('P4-C: evidence only a failed run produced does not satisfy the map', async () => {
    const children = [child('c1', 'verified', [])]
    // The child verified on its second run; the same-named product exists only
    // on the failed first run — an expired reference, not evidence.
    const runs = [run('r-c1a', 'c1', 'failed'), run('r-c1b', 'c1', 'verified')]
    const evidence = [
      bundle('e-c1a', 'r-c1a', 'c1', [verdict('ac1-1', 'fail')], [{ artifactId: 'a-stale', kind: 'bemu_trace', uri: 'traces/stale.jsonl' }]),
      bundle('e-c1b', 'r-c1b', 'c1', [verdict('ac1-1', 'pass')]),
    ]
    const verifier = new CompositeVerifier(source(children, runs, evidence))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({ childEvidence: [{ childIndex: 0, evidenceRef: 'bemu_trace' }] })]))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('bemu_trace')
    // The same reference from the verified run satisfies the map.
    const satisfied = new CompositeVerifier(source(children, runs, [
      ...evidence,
      bundle('e-c1c', 'r-c1b', 'c1', [], [{ artifactId: 'a-fresh', kind: 'bemu_trace', uri: 'traces/fresh.jsonl' }]),
    ]))
    const [ok] = await satisfied.verifyIn('sg-t-root', request([criterion({ childEvidence: [{ childIndex: 0, evidenceRef: 'bemu_trace' }] })]))
    expect(ok.status).toBe('pass')
  })

  test('a map with no children to satisfy it fails instead of degrading to the conjunction', async () => {
    const verifier = new CompositeVerifier(source([]))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({ childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }] })]))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('ac1-1')
    // The no-map criterion keeps the documented inconclusive.
    const [plain] = await verifier.verifyIn('sg-t-root', request())
    expect(plain.status).toBe('inconclusive')
    expect(plain.details).toBe('no child tasks')
  })

  test('P4-D: a natural-language criterion labeled heuristic is marked in the verdict, not silently passed', async () => {
    const verifier = new CompositeVerifier(source([child('c1', 'verified')]))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({ heuristic: true })]))
    expect(result.status).toBe('pass')
    expect(result.details).toContain('heuristic')
    // Without the label the conjunction verdict carries no heuristic marker.
    const [plain] = await verifier.verifyIn('sg-t-root', request())
    expect(plain.details).toBeUndefined()
  })
})

describe('CompositeVerifier executable selftest samples (V2-1, KISS §4.3)', () => {
  test('the declared samples are distinguishable when the real judge executes them', async () => {
    const verifier = new CompositeVerifier(source([]))
    const samples = verifier.selftest.samples
    expect(samples.map(sample => sample.role)).toEqual(['positive', 'negative'])
    const statuses: VerificationResult['status'][] = []
    for (const sample of samples) {
      const store = sample.store
      expect(store, `sample "${sample.name}" declares the store view it is judged against`).toBeDefined()
      const result = await judgeCompositeCriterion(
        sample.criterion,
        store!.children,
        async () => snapshot(store!.children, store!.runs ?? [], store!.evidence ?? []),
      )
      statuses.push(result.status)
      expect(result.verifierId).toBe('composite')
      expect(result.status, `sample "${sample.name}" expected ${sample.expect}`).toBe(sample.expect)
    }
    // The pair sits on opposite sides of the judgement: what tells them apart
    // is the fixture store, not the sample's own text.
    expect(statuses).toEqual(['pass', 'fail'])
  })
})
