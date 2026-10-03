/** Worker and reviewer reads follow responsibility branches and direct dependencies. */
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

  test('a reviewer follows its delegated branch and that branch’s dependencies', async () => {
    const { stack } = await fixture()
    stack.bindingSource(stack.ledger({ rootStoreId: 'sg-t-s-root', taskId: 't-c1', actor: 's-root', at: '2026-09-25T00:00:00.000Z' }))
    const text = expectOk(await stack.service.taskStatus('s-review', { scope: 'graph' })).text
    for (const id of ['t-root', 't-c1', 't-g1', 't-c2']) expect(text).toContain(id)
    expect(text).not.toContain('t-replay')
    for (const query of dependency) expectOk(await stack.service.contextRead('s-review', query))
    for (const query of unrelated) expectRefused(await stack.service.contextRead('s-review', query), 'not-found')
  })
})
