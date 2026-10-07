import { describe, expect, test } from 'vitest'
import type { AcceptanceCriterion, DependencyEdge } from '../../../task/src/types.ts'
import type { AdmissionChild, AdmissionParent } from '../../src/admission.ts'
import { checkDecomposition, contractDefects, rootIndependenceDefects } from '../../src/admission.ts'

function criterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    criterionId: 'ac1-1',
    description: 'it works',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    command: 'true',
    ...overrides,
  }
}

function child(overrides: Partial<AdmissionChild> = {}): AdmissionChild {
  return {
    taskId: 'c1',
    objective: 'do the thing',
    acceptanceCriteria: [criterion()],
    ...overrides,
  }
}

function parent(overrides: Partial<AdmissionParent> = {}): AdmissionParent {
  return {
    taskId: 'root',
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'ship it',
    depth: 0,
    acceptanceCriteria: [criterion({ criterionId: 'root-1', verificationMode: 'composite', command: undefined })],
    requestedCapabilities: [],
    decompositionStatus: 'decomposable',
    status: 'running',
    runIds: ['r1'],
    childTaskIds: [],
    decompositionPolicy: { allowed: true },
    ...overrides,
  }
}

describe('checkDecomposition', () => {
  test('rejects a malformed requiresArtifact declaration, shape only', () => {
    const verdict = checkDecomposition(
      parent(),
      [child({ acceptanceCriteria: [criterion({ requiresArtifact: ['bemu_trace', ''] })] })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok)
      expect(verdict.reasons.join('\n')).toMatch(/requiresArtifact must be an array of non-empty strings/)

    // A well-formed declaration passes admission untouched: existence is not
    // checked here — that judgement belongs to the orchestrator at spawn time.
    expect(
      checkDecomposition(
        parent(),
        [child({ acceptanceCriteria: [criterion({ requiresArtifact: ['bemu_trace'] })] })],
        [],
      ),
    ).toEqual({ ok: true })
  })

  test('rejects a malformed verifierRef declaration, shape only', () => {
    const verdict = checkDecomposition(
      parent(),
      [child({ acceptanceCriteria: [criterion({ verifierRef: '  ' })] })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/verifierRef must be a non-empty string/)

    // A well-formed ref passes admission untouched: whether the id is
    // registered is judged batch-level against the verifier registry, not here.
    expect(
      checkDecomposition(parent(), [child({ acceptanceCriteria: [criterion({ verifierRef: 'command' })] })], []),
    ).toEqual({ ok: true })
  })

  test('accepts a well-formed batch with a dependency chain', () => {
    const verdict = checkDecomposition(
      parent(),
      [
        child({ taskId: 'c1' }),
        child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
      ],
      [],
    )
    expect(verdict).toEqual({ ok: true })
  })

  test('rejects when the parent policy forbids decomposition', () => {
    const verdict = checkDecomposition(parent({ decompositionPolicy: { allowed: false } }), [child()], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/not allowed/)
  })

  test('names the leaf rule and the switch when that is what closed the policy', () => {
    const verdict = checkDecomposition(
      parent({ decompositionPolicy: { allowed: false, leaf: true, maxDepth: 4, maxChildren: 8 } }),
      [child()],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      const reasons = verdict.reasons.join('\n')
      expect(reasons).toMatch(/admitted as leaf/)
      expect(reasons).toMatch(/allowRuntimeDecomposition: false/)
      expect(reasons).not.toMatch(/maxDepth|maxChildren/)
    }
  })

  test('admits a leaf parent once the runtime-decomposition switch is on', () => {
    const verdict = checkDecomposition(
      parent({ decompositionPolicy: { allowed: true, leaf: true, maxDepth: 4, maxChildren: 8 } }),
      [
        child({ taskId: 'c1' }),
        child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
      ],
      [],
    )
    expect(verdict).toEqual({ ok: true })
  })

  test('still refuses a leaf parent on the limits it hits, naming them', () => {
    const overDepth = checkDecomposition(
      parent({ depth: 2, decompositionPolicy: { allowed: true, leaf: true, maxDepth: 2, maxChildren: 8 } }),
      [child()],
      [],
    )
    expect(overDepth.ok).toBe(false)
    if (!overDepth.ok) expect(overDepth.reasons.join('\n')).toMatch(/maxDepth 2 \(depth 3\)/)

    const overCount = checkDecomposition(
      parent({ decompositionPolicy: { allowed: true, leaf: true, maxDepth: 4, maxChildren: 1 } }),
      [child({ taskId: 'c1' }), child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })] })],
      [],
    )
    expect(overCount.ok).toBe(false)
    if (!overCount.ok) expect(overCount.reasons.join('\n')).toMatch(/maxChildren 1/)
  })

  test('rejects when children would exceed maxDepth', () => {
    const verdict = checkDecomposition(
      parent({ depth: 1, decompositionPolicy: { allowed: true, maxDepth: 1 } }),
      [child()],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/maxDepth 1/)
  })

  test('accepts children exactly at maxDepth', () => {
    const verdict = checkDecomposition(
      parent({ depth: 0, decompositionPolicy: { allowed: true, maxDepth: 1 } }),
      [child()],
      [],
    )
    expect(verdict).toEqual({ ok: true })
  })

  test('rejects when the batch exceeds maxChildren', () => {
    const verdict = checkDecomposition(
      parent({ decompositionPolicy: { allowed: true, maxChildren: 1 } }),
      [child({ taskId: 'c1' }), child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })] })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/maxChildren 1/)
  })

  test('rejects an empty batch', () => {
    const verdict = checkDecomposition(parent(), [], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/at least one child/)
  })

  test('rejects a child with an empty objective', () => {
    const verdict = checkDecomposition(parent(), [child({ objective: '   ' })], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/objective must be non-empty/)
  })

  test('rejects a child without acceptance criteria', () => {
    const verdict = checkDecomposition(parent(), [child({ acceptanceCriteria: [] })], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/at least one acceptance criterion/)
  })

  test.each(['deterministic', 'simulation', 'measurement'] as const)(
    'rejects an executable %s criterion without a command',
    mode => {
      const verdict = checkDecomposition(
        parent(),
        [child({ acceptanceCriteria: [criterion({ verificationMode: mode, command: undefined })] })],
        [],
      )
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(new RegExp(`${mode}\\) requires a command`))
    },
  )

  test('accepts registered review and composite criteria without a command', () => {
    const verdict = checkDecomposition(
      parent(),
      [
        child({ acceptanceCriteria: [criterion({ verificationMode: 'review', command: undefined, verifierRef: 'registered-review' })] }),
        child({
          taskId: 'c2',
          decomposable: true,
          acceptanceCriteria: [criterion({ criterionId: 'ac2-1', verificationMode: 'composite', command: undefined })],
        }),
      ],
      [],
    )
    expect(verdict).toEqual({ ok: true })
  })

  test('rejects a cyclic dependsOn graph', () => {
    const verdict = checkDecomposition(
      parent(),
      [
        child({ taskId: 'c1', dependsOn: [1] }),
        child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
      ],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/cycle/)
  })

  test('rejects a self dependency', () => {
    const verdict = checkDecomposition(parent(), [child({ dependsOn: [0] })], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/itself/)
  })

  test('rejects a cycle closed through pre-existing edges', () => {
    const existing: DependencyEdge[] = [{ from: 'c2', to: 'c1' }]
    const verdict = checkDecomposition(
      parent(),
      [
        child({ taskId: 'c1' }),
        child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
      ],
      existing,
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/cycle/)
  })

  test('rejects out-of-range dependsOn indices', () => {
    const verdict = checkDecomposition(parent(), [child({ dependsOn: [3] })], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/out of range/)
  })

  test('rejects duplicate edges against the existing DAG', () => {
    const existing: DependencyEdge[] = [{ from: 'c1', to: 'c2' }]
    const verdict = checkDecomposition(
      parent(),
      [
        child({ taskId: 'c1' }),
        child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
      ],
      existing,
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/more than once/)
  })

  test('collects multiple reasons instead of stopping at the first', () => {
    const verdict = checkDecomposition(
      parent({ decompositionPolicy: { allowed: false } }),
      [child({ objective: '' })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.length).toBeGreaterThanOrEqual(2)
  })
})

describe('checkDecomposition parent acceptance declarations (P4, KISS §6 C2)', () => {
  test.each([undefined, false])('rejects leaf composite acceptance when decomposable is %s', decomposable => {
    const verdict = checkDecomposition(parent(), [child({ decomposable, acceptanceCriteria: [criterion({
      verificationMode: 'composite', command: undefined, childEvidence: [{ childIndex: 0, evidenceRef: 'valid/id' }],
    })] })], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reasons).toHaveLength(1)
      expect(verdict.reasons[0]).toContain('decomposable: true')
      expect(verdict.reasons[0]).toContain('own children')
      expect(verdict.reasons[0]).toContain('not its position among siblings')
    }
  })

  test('accepts a well-formed childEvidence map and acceptsArtifact, shape only', () => {
    const verdict = checkDecomposition(
      parent(),
      [
        child({
          decomposable: true,
          acceptanceCriteria: [
            criterion({
              verificationMode: 'composite',
              command: undefined,
              childEvidence: [
                { childIndex: 0, criterionId: 'ac1-1' },
                { childIndex: 1, evidenceRef: 'valid/evidence_id' },
              ],
            }),
          ],
        }),
        child({
          taskId: 'c2',
          acceptanceCriteria: [criterion({ criterionId: 'ac2-1', acceptsArtifact: ['bemu_trace'] })],
        }),
      ],
      [],
    )
    expect(verdict).toEqual({ ok: true })
  })

  test('rejects malformed childEvidence entries, naming the entry', () => {
    const cases: Array<[string, unknown]> = [
      ['not an array', 'ac1-1'],
      ['a non-object entry', [42]],
      ['a negative childIndex', [{ childIndex: -1 }]],
      ['a fractional childIndex', [{ childIndex: 0.5 }]],
      ['a non-integer childIndex', [{ childIndex: '0' }]],
      ['an empty criterionId', [{ childIndex: 0, criterionId: '  ' }]],
      ['an empty evidenceRef', [{ childIndex: 0, evidenceRef: '' }]],
    ]
    for (const [label, childEvidence] of cases) {
      const verdict = checkDecomposition(
        parent(),
        [child({ acceptanceCriteria: [criterion({ childEvidence: childEvidence as never })] })],
        [],
      )
      expect(verdict.ok, label).toBe(false)
      if (!verdict.ok) expect(verdict.reasons.join('\n'), label).toMatch(/childEvidence/)
    }
  })

  test('rejects a malformed acceptsArtifact declaration', () => {
    const verdict = checkDecomposition(
      parent(),
      [child({ acceptanceCriteria: [criterion({ acceptsArtifact: ['bemu_trace', ''] })] })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/acceptsArtifact must be an array of non-empty strings/)
  })

  test('rejects a malformed heuristic flag', () => {
    const verdict = checkDecomposition(
      parent(),
      [child({ acceptanceCriteria: [criterion({ heuristic: 'yes' as never })] })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/heuristic must be a boolean/)
  })

  test('rejects a criterion that is both a heuristic judgement and carries a map', () => {
    const verdict = checkDecomposition(
      parent(),
      [child({ acceptanceCriteria: [criterion({ heuristic: true, childEvidence: [{ childIndex: 0 }] })] })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok)
      expect(verdict.reasons.join('\n')).toMatch(/cannot be both heuristic and carry a childEvidence map/)
  })

  test('P4-E: a child requiring independent acceptance without a map is refused, naming the rule', () => {
    const verdict = checkDecomposition(
      parent(),
      [child({ requiresIndependentAcceptance: true, acceptanceCriteria: [criterion()] })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      const reasons = verdict.reasons.join('\n')
      expect(reasons).toMatch(/requires independent parent acceptance/)
      expect(reasons).toMatch(/no acceptance criterion carries a childEvidence map/)
    }
  })

  test('P4-E: a deleted (empty) map is refused the same way — no silent degradation to the conjunction', () => {
    const verdict = checkDecomposition(
      parent(),
      [child({ requiresIndependentAcceptance: true, acceptanceCriteria: [criterion({ childEvidence: [] })] })],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/no acceptance criterion carries a childEvidence map/)
  })

  test('P4-E: a child requiring independent acceptance with a map is admitted', () => {
    const verdict = checkDecomposition(
      parent(),
      [
        child({
          requiresIndependentAcceptance: true,
          decomposable: true,
          acceptanceCriteria: [
            criterion({ verificationMode: 'composite', command: undefined, childEvidence: [{ childIndex: 0 }] }),
          ],
        }),
      ],
      [],
    )
    expect(verdict).toEqual({ ok: true })
  })

  test('P4-E: a parent requiring independent acceptance without a map is refused too', () => {
    const verdict = checkDecomposition(parent({ requiresIndependentAcceptance: true }), [child()], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      const reasons = verdict.reasons.join('\n')
      expect(reasons).toMatch(/task "root" requires independent parent acceptance/)
      expect(reasons).toMatch(/no acceptance criterion carries a childEvidence map/)
    }
  })

  test('a parent whose own criteria carry a malformed map is refused before anything persists', () => {
    const verdict = checkDecomposition(
      parent({
        acceptanceCriteria: [
          criterion({
            criterionId: 'root-1',
            verificationMode: 'composite',
            command: undefined,
            childEvidence: [{ childIndex: 'x' as never }],
          }),
        ],
      }),
      [child()],
      [],
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/task "root" criterion "root-1" childEvidence/)
  })
})

describe('contractDefects (T1, construction guide §4)', () => {
  test('admits a well-formed criterion list', () => {
    expect(
      contractDefects(
        [criterion(), criterion({ criterionId: 'ac1-2', verificationMode: 'review', command: undefined, verifierRef: 'registered-review' })],
        'child 0',
      ),
    ).toEqual([])
  })

  test('refuses a criterion list with nothing to judge, in the wording admission already used', () => {
    expect(contractDefects([], 'child 0')).toEqual(['child 0 requires at least one acceptance criterion'])
  })

  test('refuses a list without a mandatory criterion', () => {
    expect(contractDefects([criterion({ mandatory: false })], 'child 0')).toEqual([
      'child 0 requires at least one mandatory acceptance criterion',
    ])
    expect(contractDefects([criterion({ mandatory: false }), criterion({ criterionId: 'ac1-2' })], 'child 0')).toEqual(
      [],
    )
  })

  test('refuses a blank description', () => {
    expect(contractDefects([criterion({ description: '   ' })], 'child 0')).toEqual([
      'child 0 criterion "ac1-1" requires a non-empty description',
    ])
  })

  test('refuses a mode outside the six declared modes, naming them', () => {
    expect(contractDefects([criterion({ verificationMode: 'guess' as never })], 'child 0')).toEqual([
      'child 0 criterion "ac1-1" verificationMode "guess" is not one of ' +
        'deterministic, simulation, formal, measurement, review, composite',
    ])
  })

  test('refuses a declared null or non-mode value, naming it as declared', () => {
    // `null` is a declaration, not an absence: it reaches this rule instead of
    // being defaulted to a judge the caller never named (normalize.ts carries
    // it verbatim), and the reason shows it as the value it was.
    const cases: Array<[string, unknown]> = [
      ['a null mode', null],
      ['a numeric mode', 0],
    ]
    for (const [label, mode] of cases) {
      expect(contractDefects([criterion({ verificationMode: mode as never })], 'child 0'), label).toEqual([
        `child 0 criterion "ac1-1" verificationMode "${String(mode)}" is not one of ` +
          'deterministic, simulation, formal, measurement, review, composite',
      ])
    }
  })

  test('keeps the exact missing-command wording for the executable modes', () => {
    for (const mode of ['deterministic', 'simulation', 'measurement'] as const) {
      expect(contractDefects([criterion({ verificationMode: mode, command: undefined })], 'child 0')).toEqual([
        `child 0 criterion "ac1-1" (${mode}) requires a command`,
      ])
    }
    // An explicit registered review judge may settle without a command.
    expect(contractDefects([criterion({ verificationMode: 'review', command: undefined, verifierRef: 'custom-review' })], 'child 0')).toEqual([])
    expect(contractDefects([criterion({ command: '  ' })], 'child 0')).toEqual([
      'child 0 criterion "ac1-1" (deterministic) requires a command',
    ])
    expect(contractDefects([criterion({ command: 42 as never })], 'child 0')).toEqual([
      'child 0 criterion "ac1-1" (deterministic) requires a command',
    ])
  })

  test('refuses a criterion id declared twice inside one task', () => {
    expect(contractDefects([criterion(), criterion({ description: 'judged again' })], 'child 0')).toEqual([
      'child 0 declares criterion id "ac1-1" more than once',
    ])
  })

  test('reports every defect of one criterion list', () => {
    expect(
      contractDefects(
        [
          criterion({ criterionId: 'a', description: '', mandatory: false }),
          criterion({ criterionId: 'a', verificationMode: 'guess' as never, command: undefined, mandatory: false }),
        ],
        'child 0',
      ),
    ).toEqual([
      'child 0 criterion "a" requires a non-empty description',
      'child 0 criterion "a" verificationMode "guess" is not one of ' +
        'deterministic, simulation, formal, measurement, review, composite',
      'child 0 declares criterion id "a" more than once',
      'child 0 requires at least one mandatory acceptance criterion',
    ])
  })
})

describe('checkDecomposition contract defects (T1)', () => {
  test('emits the contract defects for a child malformed in the new ways, under the child label', () => {
    const verdict = checkDecomposition(
      parent(),
      [
        child({
          acceptanceCriteria: [
            criterion({ criterionId: 'dup', description: '  ', verificationMode: 'guess' as never, mandatory: false }),
            criterion({ criterionId: 'dup', verificationMode: 'review', command: undefined, mandatory: false }),
          ],
        }),
      ],
      [],
    )

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      const reasons = verdict.reasons.join('\n')
      expect(reasons).toContain('child 0 ("c1") criterion "dup" requires a non-empty description')
      expect(reasons).toContain(
        'child 0 ("c1") criterion "dup" verificationMode "guess" is not one of ' +
          'deterministic, simulation, formal, measurement, review, composite',
      )
      expect(reasons).toContain('child 0 ("c1") declares criterion id "dup" more than once')
      expect(reasons).toContain('child 0 ("c1") requires at least one mandatory acceptance criterion')
    }
  })

  test('still refuses an all-optional child with the one message that names the rule', () => {
    const verdict = checkDecomposition(parent(), [child({ acceptanceCriteria: [criterion({ mandatory: false })] })], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reasons).toEqual(['child 0 ("c1") requires at least one mandatory acceptance criterion'])
    }
  })
})

/**
 * The root contract's own structural rule (A0 §1.2): at least one mandatory
 * criterion judged by something other than the composite conjunction.
 *
 * It is a rule of its own rather than part of `contractDefects` because a
 * *delegated child* may legitimately be judged by "my children verified" — its
 * parent owns the goal it was handed — while a root has nobody above it, so a
 * root whose only mandatory criterion is that conjunction is satisfied by its own
 * decomposition. Both halves of that boundary are asserted here: the delegated
 * case must keep passing the structural rules, and the root case must be refused.
 */
describe('rootIndependenceDefects', () => {
  const LABEL = 'root contract of session "s-root"'

  test('accepts a root with one mandatory criterion a judge other than the conjunction settles', () => {
    expect(rootIndependenceDefects([criterion({ verificationMode: 'deterministic' })], LABEL)).toEqual([])
    expect(rootIndependenceDefects([criterion({ verificationMode: 'review', command: undefined })], LABEL)).toEqual([])
    expect(
      rootIndependenceDefects(
        [
          criterion({ verificationMode: 'composite', command: undefined }),
          criterion({ criterionId: 'ac-2', verificationMode: 'measurement' }),
        ],
        LABEL,
      ),
    ).toEqual([])
    // A *heuristic* criterion satisfies the structural rule and is still not a
    // deterministic pass: the rule says which kind of judge is named, never how
    // good that judge is (that boundary belongs to P4's labels, not here).
    expect(
      rootIndependenceDefects(
        [criterion({ criterionId: 'ac-3', heuristic: true, command: undefined, verificationMode: 'review' })],
        LABEL,
      ),
    ).toEqual([])
  })

  test('refuses a root whose only mandatory criterion is the composite conjunction, naming the rule', () => {
    const reasons = rootIndependenceDefects([criterion({ verificationMode: 'composite', command: undefined })], LABEL)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(LABEL)
    expect(reasons[0]).toContain('verificationMode !== "composite"')
    expect(reasons[0]).toContain('satisfied by its own decomposition')
  })

  test('does not count an optional non-composite criterion as the independent one', () => {
    // The conjunction is what makes the goal pass; an optional extra criterion that
    // is only consulted when the conjunction holds is not an independent check.
    const reasons = rootIndependenceDefects(
      [
        criterion({ verificationMode: 'composite', command: undefined }),
        criterion({ criterionId: 'ac-2', mandatory: false, verificationMode: 'deterministic' }),
      ],
      LABEL,
    )
    expect(reasons).toHaveLength(1)
  })

  test('refuses an empty contract as one reason, without claiming a rule about a criterion that does not exist', () => {
    const reasons = rootIndependenceDefects([], LABEL)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('requires at least one mandatory acceptance criterion judged by')
  })

  test('leaves the delegated-child case to the rules it already has', () => {
    // A child of a decomposition may be judged by the conjunction of its own
    // children: `contractDefects` accepts it, and the root rule is not applied
    // anywhere in the batch path.
    expect(contractDefects([criterion({ verificationMode: 'composite', command: undefined })], 'child 0')).toEqual([])
    expect(
      checkDecomposition(
        parent(),
        [
          child({
            decomposable: true,
            acceptanceCriteria: [criterion({ verificationMode: 'composite', command: undefined })],
          }),
        ],
        [],
      ).ok,
    ).toBe(true)
  })
})


describe('mandatory criterion settlement', () => {
  test('refuses the implicit review/formal placeholder while preserving explicit judges and composite', () => {
    for (const mode of ['review', 'formal'] as const) {
      expect(contractDefects([criterion({ verificationMode: mode, command: undefined })], 'task')).toEqual([
        `task criterion "ac1-1" (${mode}) requires an explicit registered verifier that can settle the criterion; the built-in review verifier is a placeholder`,
      ])
      expect(contractDefects([criterion({ verificationMode: mode, command: undefined, verifierRef: 'review' })], 'task')).toHaveLength(1)
      expect(contractDefects([criterion({ verificationMode: mode, command: undefined, verifierRef: 'registered-judge' })], 'task')).toEqual([])
    }
    expect(contractDefects([criterion({ verificationMode: 'composite', command: undefined })], 'task')).toEqual([])
    expect(contractDefects([
      criterion(), criterion({ criterionId: 'optional', verificationMode: 'review', mandatory: false, command: undefined }),
    ], 'task')).toEqual([])
  })
})
