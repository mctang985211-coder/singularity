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

function request(criteria: AcceptanceCriterion[] = [criterion()], runId = 'r1'): VerifyRequest {
  return { taskId: 'root', runId, criteria, cwd: '/unused', logDir: '/unused' }
}

function source(members: TaskInstance[], runs: TaskRun[] = [], evidence: EvidenceBundle[] = []) {
  return {
    runMembersIn: vi.fn(async (_storeId: string, _runId: string) => members),
    snapshotIn: vi.fn(async (_storeId: string) => snapshot(members, runs, evidence)),
  }
}

/**
 * A source whose membership is read per run: what a parent that admitted
 * several batches — or that ran twice, with its batches belonging to the run
 * that admitted each — looks like to the judge. `snapshotIn` serves every
 * member of every run, because the store holds them all.
 */
function runSource(byRun: Record<string, TaskInstance[]>, runs: TaskRun[] = [], evidence: EvidenceBundle[] = []) {
  const all = Object.values(byRun).flat()
  return {
    runMembersIn: vi.fn(async (_storeId: string, runId: string) => byRun[runId] ?? []),
    snapshotIn: vi.fn(async (_storeId: string) => snapshot(all, runs, evidence)),
  }
}

describe('CompositeVerifier', () => {
  test('supports composite mode only', () => {
    const verifier = new CompositeVerifier(source([]))
    expect(verifier.supports('composite')).toBe(true)
    expect(verifier.supports('deterministic')).toBe(false)
  })

  test('passes when every child is verified', async () => {
    const members = source([child('c1', 'verified'), child('c2', 'verified')])
    const verifier = new CompositeVerifier(members)
    const [result] = await verifier.verifyIn('sg-t-root', request())
    expect(result.status).toBe('pass')
    expect(result.verifierId).toBe('composite')
    // The membership is read for the judged run, not for its task.
    expect(members.runMembersIn).toHaveBeenCalledWith('sg-t-root', 'r1')
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

describe('CompositeVerifier run membership (K1 multi-batch)', () => {
  /** One verified member carrying the criterion a map names, with the bundle that proves it. */
  function verifiedMember(taskId: string, criterionId: string): {
    member: TaskInstance
    run: TaskRun
    evidence: EvidenceBundle
  } {
    return {
      member: child(taskId, 'verified', [criterion({ criterionId, verificationMode: 'deterministic', command: 'true' })]),
      run: run(`r-${taskId}`, taskId, 'verified'),
      evidence: bundle(`e-${taskId}`, `r-${taskId}`, taskId, [verdict(criterionId, 'pass')]),
    }
  }

  test('a childIndex is a run-level position: the second batch appends and does not renumber the first', async () => {
    const first = verifiedMember('c1', 'ac1-1')
    const second = verifiedMember('c2', 'ac2-1')
    // One run, two batches: c1 was admitted by the first, c2 by the second.
    const source = runSource(
      { r1: [first.member, second.member] },
      [first.run, second.run],
      [first.evidence, second.evidence],
    )
    const verifier = new CompositeVerifier(source)
    const [ok] = await verifier.verifyIn('sg-t-root', request([criterion({
      childEvidence: [
        { childIndex: 0, criterionId: 'ac1-1' },
        { childIndex: 1, criterionId: 'ac2-1' },
      ],
    })]))
    expect(ok.status).toBe('pass')
    expect(ok.details).toContain('child #1 (c2) criterion "ac2-1" passed')

    // The second batch's first member is not position 0 at run level: a map
    // that spelled it as one resolves the first batch's member instead and
    // fails on the criterion that member does not carry.
    const [confused] = await verifier.verifyIn('sg-t-root', request([criterion({
      childEvidence: [{ childIndex: 0, criterionId: 'ac2-1' }],
    })]))
    expect(confused.status).toBe('fail')
    expect(confused.details).toContain('child #0 (c1) has no criterion "ac2-1"')
  })

  test('a childIndex past the run\'s accumulated members fails, naming the count', async () => {
    const first = verifiedMember('c1', 'ac1-1')
    const second = verifiedMember('c2', 'ac2-1')
    const verifier = new CompositeVerifier(runSource(
      { r1: [first.member, second.member] },
      [first.run, second.run],
      [first.evidence, second.evidence],
    ))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({
      childEvidence: [{ childIndex: 2 }, { childIndex: 1, criterionId: 'ac2-1' }],
    })]))
    expect(result.status).toBe('fail')
    // Only the out-of-range entry is defective: the other entry is satisfied,
    // so a missing member does not turn the whole map into noise.
    expect(result.details).toBe('incomplete childEvidence map: child #2 does not exist (the run\'s batches have admitted 2 members)')
  })

  test('historical members belong to their own run: run2 resolves run2\'s first member', async () => {
    const old = verifiedMember('c1', 'ac1-1')
    const current = verifiedMember('c9', 'ac9-1')
    const verifier = new CompositeVerifier(runSource(
      { r1: [old.member], r2: [current.member] },
      [old.run, current.run],
      [old.evidence, current.evidence],
    ))
    const [result] = await verifier.verifyIn('sg-t-root', request([criterion({
      childEvidence: [{ childIndex: 0, criterionId: 'ac9-1' }],
    })], 'r2'))
    expect(result.status).toBe('pass')
    expect(result.details).toContain('child #0 (c9) criterion "ac9-1" passed')
    expect(result.details).not.toContain('c1')

    // The first run still answers with its own member — the two runs' members
    // are not one list — and a run that admitted no batch has none at all.
    const [earlier] = await verifier.verifyIn('sg-t-root', request([criterion({
      childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }],
    })], 'r1'))
    expect(earlier.status).toBe('pass')
    expect(earlier.details).toContain('child #0 (c1)')
    const [none] = await verifier.verifyIn('sg-t-root', request([criterion()], 'r3'))
    expect(none.status).toBe('inconclusive')
    expect(none.details).toBe('no child tasks')
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
