/**
 * Where a read is allowed to look (A2 §D/§E), on the fixture's real store: the
 * caller's own membership and its persistent `TaskStarted`, the reviewer
 * ledger's delegation, and every named way a binding can fail.
 */

import { describe, expect, test } from 'vitest'
import { rootTaskStoreId } from '../../../task/src/index.ts'
import { ReviewerBindingError } from '../../src/index.ts'
import { FixtureStack, seedChain, type Chain } from '../support/stack.ts'
import { expectOk, expectRefused, expectResolved } from '../support/stack.ts'

const DEPARTMENT = {
  rootStoreId: 'sg-t-s-root',
  taskId: 't-c1',
  actor: 's-root',
  at: '2026-09-25T00:00:00.000Z',
} as const

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

/** A second graph in the same deployment: another root session, another store, the same cwd. */
async function secondGraph(stack: FixtureStack): Promise<{ storeId: string; taskId: string; runId: string }> {
  stack.graph({ id: 'g-2', rootSessionId: 's-root-2', members: [] })
  stack.sessionLog('s-root-2', ['second graph request'])
  await stack.seed({ taskId: 't-other', sessionId: 's-root-2', runId: 'r-other', objective: 'the other graph objective' })
  return { storeId: rootTaskStoreId('s-root-2'), taskId: 't-other', runId: 'r-other' }
}

describe('caller resolution', () => {
  test('a worker resolves through its published membership and its persistent run', async () => {
    const { stack, chain } = await chainStack()
    const resolution = expectResolved(await stack.service.resolveCaller('s-g1'))
    expect(resolution.kind).toBe('worker')
    expect(resolution.storeId).toBe(chain.storeId)
    expect(resolution.graph.id).toBe(chain.graph)
    if (resolution.kind !== 'worker') throw new Error('expected a worker')
    expect(resolution.task.taskId).toBe('t-g1')
    expect(resolution.run.runId).toBe('r-g1')
    expect(resolution.recovery).toEqual({ status: 'ready' })
  })

  test('a root resolves by the run whose session is the graph root session', async () => {
    const { stack } = await chainStack()
    const resolution = expectResolved(await stack.service.resolveCaller('s-root'))
    expect(resolution.kind).toBe('root')
    if (resolution.kind !== 'root') throw new Error('expected a root')
    // The store also holds a parentless replay task; the root is the one whose
    // session the run names, never "the first parentless task".
    expect(resolution.task?.taskId).toBe('t-root')
    expect(resolution.run?.runId).toBe('r-root')
  })

  test('a replay task is not the root: its session resolves to its own run', async () => {
    const { stack, chain } = await chainStack()
    const resolution = expectResolved(await stack.service.resolveCaller(chain.replaySession))
    expect(resolution.kind).toBe('worker')
    if (resolution.kind !== 'worker') throw new Error('expected a worker')
    expect(resolution.task.taskId).toBe('t-replay')
    expect(resolution.task.parentTaskId).toBeUndefined()
    expect(resolution.run.parentRunId).toBe('r-root')
  })

  test('a published member with no run reads the domain but has no contract of its own', async () => {
    const { stack } = await chainStack()
    stack.member('g-s-root', 's-bystander')
    const resolution = expectResolved(await stack.service.resolveCaller('s-bystander'))
    expect(resolution.kind).toBe('member')
    expect(expectRefused(await stack.service.taskRead('s-bystander'), 'unbound')).toContain('is not a substitute')
    // The domain is still readable for a member: the status view answers.
    expect(expectOk(await stack.service.taskStatus('s-bystander', { scope: 'graph' })).text).toContain('t-root')
  })

  test('a session in no graph and with no delegation is unbound', async () => {
    const { stack } = await chainStack()
    const resolution = await stack.service.resolveCaller('s-stranger')
    expect(resolution.kind).toBe('unbound')
    if (resolution.kind !== 'unbound') throw new Error('expected unbound')
    expect(resolution.refusal).toBe('unbound')
    expect(resolution.detail).toContain('not a published member of any graph')
    expect(expectRefused(await stack.service.taskRead('s-stranger'), 'unbound')).toContain('never placed by the ids it passes')
  })

  test('a store that cannot be opened is unreadable, not an empty domain', async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-broken', rootSessionId: 's-broken' })
    stack.sessionLog('s-broken', ['broken graph request'])
    stack.sessionLog(rootTaskStoreId('s-broken'), ['not a task store'])
    const persistence = (stack.ctx as unknown as { sessionPersistence: { open(id: string): Promise<unknown> } }).sessionPersistence
    const original = persistence.open.bind(persistence)
    persistence.open = async (id: string) => {
      if (id === rootTaskStoreId('s-broken')) throw new Error('task store log is corrupt')
      return await original(id)
    }
    expect(expectRefused(await stack.service.taskRead('s-broken'), 'unreadable')).toContain('cannot be read')
  })
})

describe('cross-graph reads', () => {
  test('two graphs in one deployment cannot read each other, and a guessed id authorizes nothing', async () => {
    const { stack, chain } = await chainStack()
    const other = await secondGraph(stack)

    // The task of the other graph is not in this caller's domain: named, and no
    // domain is opened for it.
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'task', ref: other.taskId }), 'not-found'))
      .toContain('never widens the read domain')
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'run', ref: other.runId }), 'not-found'))
      .toContain('ids from another graph are not readable here')
    // A session reference is checked against the graph's published members, so
    // the refusal can name the real reason before any history is touched.
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-root-2' }), 'cross-graph'))
      .toContain('not a published member of graph')
    // The same holds in the other direction, and for the status view.
    expect(expectRefused(await stack.service.contextRead('s-root-2', { kind: 'task', ref: chain.child.taskId }), 'not-found'))
    const graphScope = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph' })).text
    expect(graphScope).not.toContain('t-other')
    expect(graphScope).toContain('t-root')
    // And the caller's own domain is untouched by the attempt.
    expect(expectOk(await stack.service.contextRead('s-g1', { kind: 'task', ref: chain.root.taskId })).text).toContain('t-root')
  })
})

describe('reviewer delegation', () => {
  test('a ledger row binds the reviewer to the delegated graph, review-only', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    const resolution = expectResolved(await stack.service.resolveCaller('s-review'))
    expect(resolution.kind).toBe('reviewer')
    if (resolution.kind !== 'reviewer') throw new Error('expected a reviewer')
    expect(resolution.task?.taskId).toBe('t-c1')
    expect(resolution.delegation.actor).toBe('s-root')

    const read = expectOk(await stack.service.taskRead('s-review'))
    expect(read.text).toContain('review-only')
    expect(read.text).toContain('child one: build the bridge')
    // The delegated domain is the whole graph, not one task: the sibling's
    // evidence and a session of the graph are readable by reference.
    expect(expectOk(await stack.service.contextRead('s-review', { kind: 'evidence', ref: 'e-c2' })).text).toContain('e-c2')
    expect(expectOk(await stack.service.contextRead('s-review', { kind: 'session', ref: 's-c1' })).text).toContain('child one')
  })

  test('a reviewer\'s dynamic state is the delegated task, under its review-only label', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    const text = expectOk(await stack.service.dynamicProjection('s-review')).text
    expect(text).toContain('role: reviewer')
    expect(text).toContain('delegated task state (review-only, no business Run)')
    expect(text).toContain('run r-c1 [running]')
    expect(text).not.toContain('your run:')
    expect(text).toContain('gate phase: not tracked for this session')
  })

  test('without a ledger row the reviewer session is only a member, and reads no contract', async () => {
    const { stack } = await chainStack()
    const resolution = expectResolved(await stack.service.resolveCaller('s-review'))
    expect(resolution.kind).toBe('member')
    expect(expectRefused(await stack.service.taskRead('s-review'), 'unbound')).toContain('no recorded delegation')
  })

  test('a ledger that cannot answer one row raises the conflict, and it is named', async () => {
    const { stack } = await chainStack()
    stack.bindingSource({
      read: async () => {
        throw new ReviewerBindingError('binding-conflict', 'two conflicting rows for one session')
      },
    })
    const resolution = await stack.service.resolveCaller('s-review')
    expect(resolution.kind).toBe('unbound')
    if (resolution.kind !== 'unbound') throw new Error('expected unbound')
    expect(resolution.refusal).toBe('binding-conflict')
    expect(expectRefused(await stack.service.taskRead('s-review'), 'binding-conflict')).toContain('two conflicting rows')
  })

  test('two sources that disagree about one session are a conflict, not a coin toss', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    const conflicting = stack.bindingSource(stack.ledger({ ...DEPARTMENT, taskId: 't-c2' }))
    expect(expectRefused(await stack.service.taskRead('s-review'), 'binding-conflict')).toContain('more than one reviewer delegation')
    // With the disagreeing source gone, the remaining one is the delegation.
    conflicting()
    const again = expectOk(await stack.service.taskRead('s-review'))
    expect(again.text).toContain('child one: build the bridge')
  })

  test('a delegation naming another graph store is cross-graph', async () => {
    const { stack } = await chainStack()
    await secondGraph(stack)
    stack.bindingSource(stack.ledger({ ...DEPARTMENT, rootStoreId: rootTaskStoreId('s-root-2'), taskId: 't-other' }))
    const detail = expectRefused(await stack.service.taskRead('s-review'), 'cross-graph')
    expect(detail).toContain('never moves a session into another graph')
  })

  test('a delegation naming a task the store does not hold reads not-found', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger({ ...DEPARTMENT, taskId: 't-nope' }))
    const resolution = expectResolved(await stack.service.resolveCaller('s-review'))
    expect(resolution.kind).toBe('reviewer')
    if (resolution.kind !== 'reviewer') throw new Error('expected a reviewer')
    expect(resolution.task).toBeUndefined()
    expect(expectRefused(await stack.service.taskRead('s-review'), 'not-found')).toContain('t-nope')
  })

  test('a delegation whose session is not published is still placed by its store', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    const resolution = expectResolved(await stack.service.resolveCaller('s-unpublished-reviewer'))
    expect(resolution.kind).toBe('reviewer')
    expect(expectOk(await stack.service.taskRead('s-unpublished-reviewer')).text).toContain('review-only')
  })

  test('the disposer removes a source again', async () => {
    const { stack } = await chainStack()
    const dispose = stack.bindingSource(stack.ledger(DEPARTMENT))
    expect(expectOk(await stack.service.taskRead('s-review')).text).toContain('review-only')
    dispose()
    expect(expectRefused(await stack.service.taskRead('s-review'), 'unbound'))
  })
})

describe('not activated', () => {
  test('a root session whose graph holds no root contract answers not-activated, never a guessed root', async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-empty', rootSessionId: 's-empty' })
    stack.sessionLog('s-empty', ['a request nobody has contracted yet'])
    const detail = expectRefused(await stack.service.taskRead('s-empty'), 'not-activated')
    expect(detail).toContain('not activated')
    expect(detail).toContain('does not exist yet')
    expect(detail).toContain('task_intake')
    expect(detail).toContain('no objective is reported here')
    expect(expectRefused(await stack.service.contractProjection('s-empty'), 'not-activated')).toContain('task_intake')
    expect(expectRefused(await stack.service.taskStatus('s-empty', { scope: 'graph' }), 'not-activated')).toContain('task_intake')
  })

  test('a store that exists with no root task answers the same named state', async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-held', rootSessionId: 's-held' })
    stack.sessionLog('s-held', ['a request nobody has contracted yet'])
    const storeId = rootTaskStoreId('s-held')
    await stack.task.createStore(storeId)
    expect(expectRefused(await stack.service.taskRead('s-held'), 'not-activated')).toContain('opened, with no root task in it')
  })
})
