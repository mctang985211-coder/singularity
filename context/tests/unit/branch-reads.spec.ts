/** Workers retain their branch; trusted coordination delegations inspect the same graph, read-only. */
import { describe, expect, test, vi } from 'vitest'
import type { ContextReadQuery } from '../../src/types.ts'
import { FixtureStack, expectOk, expectRefused, seedChain } from '../support/stack.ts'

async function fixture() {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  await stack.evidence({ evidenceId: 'e-replay', taskId: 't-replay', runId: 'r-replay', sessionId: 's-replay' })
  await stack.verify({ taskId: 't-replay', runId: 'r-replay', sessionId: 's-replay', evidenceRefs: ['e-replay'] })
  await stack.diagnose({ taskId: 't-replay', diagnosisId: 'd-replay', sessionId: 's-replay', evidenceRefs: ['e-replay'] })
  return { stack, chain }
}

const unrelated: ContextReadQuery[] = [
  { kind: 'task', ref: 't-replay' }, { kind: 'run', ref: 'r-replay' },
  { kind: 'evidence', ref: 'e-replay' }, { kind: 'review', ref: { taskId: 't-replay', runId: 'r-replay' } },
  { kind: 'diagnosis', ref: 'd-replay' }, { kind: 'session', ref: 's-replay' },
  { kind: 'session', ref: { sessionId: 's-replay', seq: 0 } },
]
const dependency: ContextReadQuery[] = [
  { kind: 'task', ref: 't-c2' }, { kind: 'run', ref: 'r-c2' },
  { kind: 'evidence', ref: 'e-c2' }, { kind: 'review', ref: { taskId: 't-c2', runId: 'r-c2' } },
  { kind: 'diagnosis', ref: 'd-c2' }, { kind: 'session', ref: 's-c2' },
  { kind: 'session', ref: { sessionId: 's-c2', seq: 0 } },
]

describe('branch read boundaries', () => {
  test('a worker retains its branch, ancestors and dependencies, including evidence and logs', async () => {
    const { stack } = await fixture()
    for (const query of dependency) expectOk(await stack.service.contextRead('s-g1', query))
    for (const id of ['t-root', 't-c1', 't-g1']) expectOk(await stack.service.contextRead('s-g1', { kind: 'task', ref: id }))
    for (const query of unrelated) expectRefused(await stack.service.contextRead('s-g1', query), 'not-found')
    const text = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph' })).text
    expect(text).toContain('t-c2')
    expect(text).not.toContain('t-replay')
    expect(text).toContain('branch')
  })

  test('unrelated sessions are refused before accessing either log API', async () => {
    const { stack } = await fixture()
    const query = (stack.ctx as unknown as { sessionQuery: { readSession: (...args: unknown[]) => unknown; readEvent: (...args: unknown[]) => unknown } }).sessionQuery
    const session = vi.spyOn(query, 'readSession')
    const event = vi.spyOn(query, 'readEvent')
    expectRefused(await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-replay' }), 'not-found')
    expectRefused(await stack.service.contextRead('s-g1', { kind: 'session', ref: { sessionId: 's-replay', seq: 0 } }), 'not-found')
    expect(session).not.toHaveBeenCalled()
    expect(event).not.toHaveBeenCalled()
  })

  test('root and the published supervisor member retain the full domain', async () => {
    const { stack, chain } = await fixture()
    stack.member(chain.graph, 's-supervisor')
    for (const caller of ['s-root', 's-supervisor']) {
      for (const query of unrelated) expectOk(await stack.service.contextRead(caller, query))
      expect(expectOk(await stack.service.taskStatus(caller, { scope: 'graph' })).text).toContain('t-replay')
    }
  })

  test('a valid coordinator reads peers and history throughout its delegated graph without changing the store', async () => {
    const { stack } = await fixture()
    stack.bindingSource(stack.ledger({ rootStoreId: 'sg-t-s-root', sourceTaskId: 't-c1', sourceRunId: null, role: 'reviewer', actor: 's-root', at: '2026-09-25T00:00:00.000Z' }))
    const before = await stack.snapshot('sg-t-s-root')
    const text = expectOk(await stack.service.taskStatus('s-review', { scope: 'graph' })).text
    for (const id of ['t-root', 't-c1', 't-g1', 't-c2', 't-replay']) expect(text).toContain(id)
    expect(text).toContain('delegated graph, read-only')
    expect(text).toContain('r-replay=session s-replay')
    expect(text).toContain('reviewRefs [t-replay#r-replay]')
    expect(text).toContain('diagnosisRefs [d-replay]')
    for (const query of dependency) expectOk(await stack.service.contextRead('s-review', query))
    for (const query of unrelated) expectOk(await stack.service.contextRead('s-review', query))
    expect(await stack.snapshot('sg-t-s-root')).toEqual(before)
  })

  test('a missing delegated task opens no task or session references', async () => {
    const { stack } = await fixture()
    stack.bindingSource(stack.ledger({ rootStoreId: 'sg-t-s-root', sourceTaskId: 't-missing', sourceRunId: null, role: 'reviewer', actor: 's-root', at: '2026-09-25T00:00:00.000Z' }))
    const text = expectOk(await stack.service.taskStatus('s-review', { scope: 'graph' })).text
    expect(text).toContain('entries in scope: 0')
    for (const query of [...dependency, ...unrelated]) expectRefused(await stack.service.contextRead('s-review', query), 'not-found')
    expectRefused(await stack.service.contextRead('s-review', { kind: 'session', ref: 's-review' }), 'not-found')
  })

  test('full graph visibility keeps the cross-graph session check before either log API', async () => {
    const { stack } = await fixture()
    stack.bindingSource(stack.ledger({ rootStoreId: 'sg-t-s-root', sourceTaskId: 't-c1', sourceRunId: null, role: 'reviewer', actor: 's-root', at: '2026-09-25T00:00:00.000Z' }))
    stack.graph({ id: 'g-other', rootSessionId: 's-other' })
    stack.sessionLog('s-other', ['another graph'])
    const query = (stack.ctx as unknown as { sessionQuery: { readSession: (...args: unknown[]) => unknown; readEvent: (...args: unknown[]) => unknown } }).sessionQuery
    const session = vi.spyOn(query, 'readSession')
    const event = vi.spyOn(query, 'readEvent')
    expectRefused(await stack.service.contextRead('s-review', { kind: 'session', ref: 's-other' }), 'cross-graph')
    expectRefused(await stack.service.contextRead('s-review', { kind: 'session', ref: { sessionId: 's-other', seq: 0 } }), 'cross-graph')
    expect(session).not.toHaveBeenCalled()
    expect(event).not.toHaveBeenCalled()
  })
})
