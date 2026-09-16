import { describe, expect, test } from 'vitest'
import type { AcceptanceCriterion, DependencyEdge } from '../../../task/src/types.ts'
import type { AdmissionChild, AdmissionParent } from '../../src/admission.ts'
import { checkDecomposition } from '../../src/admission.ts'

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
  test('accepts a well-formed batch with a dependency chain', () => {
    const verdict = checkDecomposition(parent(), [
      child({ taskId: 'c1' }),
      child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
    ], [])
    expect(verdict).toEqual({ ok: true })
  })

  test('rejects when the parent policy forbids decomposition', () => {
    const verdict = checkDecomposition(parent({ decompositionPolicy: { allowed: false } }), [child()], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/not allowed/)
  })

  test('rejects when children would exceed maxDepth', () => {
    const verdict = checkDecomposition(parent({ depth: 1, decompositionPolicy: { allowed: true, maxDepth: 1 } }), [child()], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/maxDepth 1/)
  })

  test('accepts children exactly at maxDepth', () => {
    const verdict = checkDecomposition(parent({ depth: 0, decompositionPolicy: { allowed: true, maxDepth: 1 } }), [child()], [])
    expect(verdict).toEqual({ ok: true })
  })

  test('rejects when the batch exceeds maxChildren', () => {
    const verdict = checkDecomposition(parent({ decompositionPolicy: { allowed: true, maxChildren: 1 } }), [
      child({ taskId: 'c1' }),
      child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })] }),
    ], [])
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
      const verdict = checkDecomposition(parent(), [
        child({ acceptanceCriteria: [criterion({ verificationMode: mode, command: undefined })] }),
      ], [])
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(new RegExp(`${mode}\\) requires a command`))
    },
  )

  test('accepts review and composite criteria without a command', () => {
    const verdict = checkDecomposition(parent(), [
      child({ acceptanceCriteria: [criterion({ verificationMode: 'review', command: undefined })] }),
      child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1', verificationMode: 'composite', command: undefined })] }),
    ], [])
    expect(verdict).toEqual({ ok: true })
  })

  test('rejects a cyclic dependsOn graph', () => {
    const verdict = checkDecomposition(parent(), [
      child({ taskId: 'c1', dependsOn: [1] }),
      child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
    ], [])
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
    const verdict = checkDecomposition(parent(), [
      child({ taskId: 'c1' }),
      child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
    ], existing)
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
    const verdict = checkDecomposition(parent(), [
      child({ taskId: 'c1' }),
      child({ taskId: 'c2', acceptanceCriteria: [criterion({ criterionId: 'ac2-1' })], dependsOn: [0] }),
    ], existing)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toMatch(/more than once/)
  })

  test('collects multiple reasons instead of stopping at the first', () => {
    const verdict = checkDecomposition(parent({ decompositionPolicy: { allowed: false } }), [
      child({ objective: '' }),
    ], [])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.length).toBeGreaterThanOrEqual(2)
  })
})
