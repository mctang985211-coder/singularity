/**
 * The coordination binding seam: a role is required and never assumed, the
 * delegator is still checked against the graph, and the role a binding records
 * is the role both model-visible planes print.
 */

import { describe, expect, test } from 'vitest'
import { CoordinationBindingError } from '../../src/index.ts'
import type { CoordinationBinding } from '../../src/index.ts'
import { FixtureStack, seedChain, expectOk, expectRefused, expectResolved } from '../support/stack.ts'
import type { Chain } from '../support/stack.ts'

/** A delegation into the chain's root store, by the graph's own root session. */
function binding(over: Partial<CoordinationBinding> = {}): CoordinationBinding {
  return {
    rootStoreId: 'sg-t-s-root',
    sourceTaskId: 't-c1',
    sourceRunId: null,
    role: 'reviewer',
    actor: 's-root',
    at: '2026-10-08T00:00:00.000Z',
    ...over,
  }
}

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

describe('a binding without a role', () => {
  test('is refused, never read as a reviewer', async () => {
    const { stack } = await chainStack()
    const roleless = { ...binding(), role: undefined } as unknown as CoordinationBinding
    stack.bindingSource(stack.ledger(roleless))

    const resolution = await stack.service.resolveCaller('s-review')

    expect(resolution.kind).toBe('unbound')
    if (resolution.kind !== 'unbound') throw new Error('expected unbound')
    expect(resolution.placement).toBe('failed')
    expect(resolution.refusal).toBe('binding-conflict')
    expect(resolution.detail).toContain('names no role')
    expect(resolution.detail).toContain('never assumed')
    expect(expectRefused(await stack.service.taskRead('s-review'), 'binding-conflict')).toContain('names no role')
  })

  test('is refused when the source raises it, and the raised detail is what a caller reads', async () => {
    const { stack } = await chainStack()
    stack.bindingSource({
      read: async () => {
        throw new CoordinationBindingError('role-missing', 'the ledger row for this session records no role')
      },
    })

    expect(expectRefused(await stack.service.taskRead('s-review'), 'binding-conflict')).toContain('records no role')
  })

  test('leaves a session no graph publishes outside the deployment, so placement still differs', async () => {
    const { stack } = await chainStack()
    const roleless = { ...binding(), role: undefined } as unknown as CoordinationBinding
    stack.bindingSource({ read: async sessionId => (sessionId === 's-review' ? roleless : undefined) })

    const stranger = await stack.service.resolveCaller('s-stranger')
    expect(stranger.kind).toBe('unbound')
    if (stranger.kind !== 'unbound') throw new Error('expected unbound')
    expect(stranger.placement).toBe('outside')
  })
})

describe('the role a binding records is the role that is printed', () => {
  test('a supervisor reads the source contract under its supervision responsibility', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(binding({ role: 'supervisor', sourceRunId: 'r-c1' })))

    const contract = expectOk(await stack.service.contractProjection('s-review')).text
    expect(contract).toContain('role: supervisor')
    expect(contract).toContain('## Source contract (method supervision, no business Run)')
    expect(contract).toContain('responsibility: investigate and compare reusable method candidates')
    expect(contract).toContain('exact source Run: r-c1')

    const dynamic = expectOk(await stack.service.dynamicProjection('s-review')).text
    expect(dynamic).toContain('role: supervisor')
    expect(dynamic).toContain('method supervision')
  })

  test('a coordinator reads the delegated contract under its own heading', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(binding({ role: 'coordinator' })))

    const contract = expectOk(await stack.service.contractProjection('s-review')).text
    expect(contract).toContain('role: coordinator')
    expect(contract).toContain('## Delegated contract (coordination, no business Run)')
    expect(contract).not.toContain('responsibility: investigate and compare')
    expect(expectOk(await stack.service.dynamicProjection('s-review')).text).toContain('role: coordinator')
  })

  test('a reviewer keeps the review-only label both planes have always carried', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(binding({ role: 'reviewer' })))

    expect(expectOk(await stack.service.taskRead('s-review')).text).toContain('review-only')
    expect(expectOk(await stack.service.dynamicProjection('s-review')).text).toContain(
      'delegated task state (review-only, no business Run)',
    )
    expect(expectResolved(await stack.service.resolveCaller('s-review'))).toMatchObject({
      kind: 'coordinator',
      role: 'reviewer',
      binding: { sourceTaskId: 't-c1', actor: 's-root', rootStoreId: 'sg-t-s-root' },
    })
  })
})

describe('the delegator check is unchanged by the role', () => {
  test('a delegator another graph owns grants nothing, whatever role the binding names', async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-2', rootSessionId: 's-root-2', members: [] })
    stack.sessionLog('s-root-2', ['second graph request'])
    await stack.seed({ taskId: 't-other', sessionId: 's-root-2', runId: 'r-other', objective: 'the other objective' })
    stack.bindingSource(stack.ledger(binding({ role: 'supervisor', actor: 's-root-2' })))

    const detail = expectRefused(await stack.service.taskRead('s-review'), 'cross-graph')
    expect(detail).toContain('s-root-2')
    expect(detail).toContain('does not publish')
  })

  test('a binding that names a task this store does not hold reads not-found, not a narrower domain', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(binding({ role: 'supervisor', sourceTaskId: 't-nope' })))

    expect(expectRefused(await stack.service.taskRead('s-review'), 'not-found')).toContain('t-nope')
  })
})

describe('no source and a broken source', () => {
  test('a deployment without a binding source reads a published member as a member', async () => {
    const { stack } = await chainStack()

    expect(await stack.service.resolveCaller('s-review')).toMatchObject({ kind: 'member' })
  })

  test('a source that cannot answer one row is named, never read as "no binding"', async () => {
    const { stack } = await chainStack()
    stack.bindingSource({
      read: async () => {
        throw new CoordinationBindingError('unreadable', 'the coordination ledger cannot be read')
      },
    })

    expect(expectRefused(await stack.service.taskRead('s-review'), 'unreadable')).toContain('cannot be read')
  })

  test('the disposer removes a source again', async () => {
    const { stack } = await chainStack()
    const dispose = stack.bindingSource(stack.ledger(binding()))
    expect(expectOk(await stack.service.taskRead('s-review')).text).toContain('review-only')
    dispose()
    expect(await stack.service.resolveCaller('s-review')).toMatchObject({ kind: 'member' })
  })
})
