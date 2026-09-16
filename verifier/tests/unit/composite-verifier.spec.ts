import { describe, expect, test, vi } from 'vitest'
import type { AcceptanceCriterion, TaskInstance, VerifyRequest } from '../../../task/src/types.ts'
import { CompositeVerifier } from '../../src/composite-verifier.ts'

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

function child(taskId: string, status: TaskInstance['status']): TaskInstance {
  return {
    taskId,
    definitionRef: { taskType: 'build', version: 1 },
    parentTaskId: 'root',
    objective: 'child work',
    depth: 1,
    acceptanceCriteria: [],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status,
    runIds: [],
    childTaskIds: [],
  }
}

function request(criteria: AcceptanceCriterion[] = [criterion()]): VerifyRequest {
  return { taskId: 'root', runId: 'r1', criteria, cwd: '/unused', logDir: '/unused' }
}

function source(children: TaskInstance[]) {
  return { childrenIn: vi.fn(async (_storeId: string, _taskId: string) => children) }
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
