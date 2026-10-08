/**
 * Where a read is allowed to look (A2 §D/§E), on the fixture's real store: the
 * caller's own membership and its persistent `TaskStarted`, the coordination
 * ledger's delegation, and every named way a binding can fail.
 */

import { describe, expect, test, vi } from 'vitest'
import { rootTaskStoreId } from '../../../task/src/index.ts'
import { CoordinationBindingError } from '../../src/index.ts'
import { FixtureStack, seedChain, type Chain } from '../support/stack.ts'
import { expectOk, expectRefused, expectResolved } from '../support/stack.ts'

const DEPARTMENT = {
  rootStoreId: 'sg-t-s-root',
  sourceTaskId: 't-c1',
  sourceRunId: null,
  role: 'reviewer',
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
  await stack.seed({
    taskId: 't-other',
    sessionId: 's-root-2',
    runId: 'r-other',
    objective: 'the other graph objective',
  })
  return { storeId: rootTaskStoreId('s-root-2'), taskId: 't-other', runId: 'r-other' }
}

/** Make one store's log answer as a corrupt file does: an unreadable store, not an absent one. */
function breakStoreLog(stack: FixtureStack, storeId: string): void {
  const persistence = (stack.ctx as unknown as { sessionPersistence: { open(id: string): Promise<unknown> } })
    .sessionPersistence
  const original = persistence.open.bind(persistence)
  persistence.open = async (id: string) => {
    if (String(id) === storeId) throw new Error('the task store log is corrupt')
    return await original(id)
  }
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
    expect(expectRefused(await stack.service.taskRead('s-stranger'), 'unbound')).toContain(
      'never placed by the ids it passes',
    )
  })

  test('a store that cannot be opened is unreadable, not an empty domain', async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-broken', rootSessionId: 's-broken' })
    stack.sessionLog('s-broken', ['broken graph request'])
    stack.sessionLog(rootTaskStoreId('s-broken'), ['not a task store'])
    const persistence = (stack.ctx as unknown as { sessionPersistence: { open(id: string): Promise<unknown> } })
      .sessionPersistence
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
    expect(
      expectRefused(await stack.service.contextRead('s-g1', { kind: 'task', ref: other.taskId }), 'not-found'),
    ).toContain('never widens the read domain')
    expect(
      expectRefused(await stack.service.contextRead('s-g1', { kind: 'run', ref: other.runId }), 'not-found'),
    ).toContain('ids from another graph are not readable here')
    // A session reference is checked against the graph's published members, so
    // the refusal can name the real reason before any history is touched.
    expect(
      expectRefused(await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-root-2' }), 'cross-graph'),
    ).toContain('not a published member of graph')
    // The same holds in the other direction, and for the status view.
    expect(
      expectRefused(
        await stack.service.contextRead('s-root-2', { kind: 'task', ref: chain.child.taskId }),
        'not-found',
      ),
    )
    const graphScope = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph' })).text
    expect(graphScope).not.toContain('t-other')
    expect(graphScope).toContain('t-root')
    // And the caller's own domain is untouched by the attempt.
    expect(expectOk(await stack.service.contextRead('s-g1', { kind: 'task', ref: chain.root.taskId })).text).toContain(
      't-root',
    )
  })
})

describe('coordination delegation', () => {
  test.each(['s-review', 's-unpublished-reviewer'])('resolves %s from one domain snapshot and one recovery observation', async sessionId => {
    const { stack, chain } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    stack.recoveryStatus(chain.storeId, { status: 'ready' })
    const open = vi.spyOn(stack.task, 'snapshotReadOnly')
    stack.observed.recoveryStatus.mockClear()

    const loaded = await stack.service.load(sessionId)

    expect(loaded.resolution).toMatchObject({ kind: 'coordinator', task: { taskId: 't-c1' }, recovery: { status: 'ready' } })
    expect(loaded.snapshot?.id).toBe(chain.storeId)
    expect(open).toHaveBeenCalledExactlyOnceWith(chain.storeId)
    expect(stack.observed.recoveryStatus).toHaveBeenCalledExactlyOnceWith(chain.storeId)
  })

  test('a ledger row binds the coordinator to the delegated graph, review-only', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    const resolution = expectResolved(await stack.service.resolveCaller('s-review'))
    expect(resolution.kind).toBe('coordinator')
    if (resolution.kind !== 'coordinator') throw new Error('expected a coordinator')
    expect(resolution.task?.taskId).toBe('t-c1')
    expect(resolution.binding.actor).toBe('s-root')

    const read = expectOk(await stack.service.taskRead('s-review'))
    expect(read.text).toContain('review-only')
    expect(read.text).toContain('child one: build the bridge')
    // The delegated domain is the whole graph, not one task: the sibling's
    // evidence and a session of the graph are readable by reference.
    expect(expectOk(await stack.service.contextRead('s-review', { kind: 'evidence', ref: 'e-c2' })).text).toContain(
      'e-c2',
    )
    expect(expectOk(await stack.service.contextRead('s-review', { kind: 'session', ref: 's-c1' })).text).toContain(
      'child one',
    )
  })

  test("a coordinator's dynamic state is the delegated task, under its review-only label", async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    const text = expectOk(await stack.service.dynamicProjection('s-review')).text
    expect(text).toContain('role: reviewer')
    expect(text).toContain('delegated task state (review-only, no business Run)')
    expect(text).toContain('run r-c1 [running]')
    expect(text).not.toContain('your run:')
    expect(text).toContain('gate phase: not tracked for this session')
  })

  test('without a ledger row the coordinator session is only a member, and reads no contract', async () => {
    const { stack } = await chainStack()
    const resolution = expectResolved(await stack.service.resolveCaller('s-review'))
    expect(resolution.kind).toBe('member')
    expect(expectRefused(await stack.service.taskRead('s-review'), 'unbound')).toContain('no recorded delegation')
  })

  test('a ledger that cannot answer one row raises the conflict, and it is named', async () => {
    const { stack } = await chainStack()
    stack.bindingSource({
      read: async () => {
        throw new CoordinationBindingError('binding-conflict', 'two conflicting rows for one session')
      },
    })
    const resolution = await stack.service.resolveCaller('s-review')
    expect(resolution.kind).toBe('unbound')
    if (resolution.kind !== 'unbound') throw new Error('expected unbound')
    expect(resolution.refusal).toBe('binding-conflict')
    expect(expectRefused(await stack.service.taskRead('s-review'), 'binding-conflict')).toContain(
      'two conflicting rows',
    )
  })

  test('a delegation naming another graph store is cross-graph', async () => {
    const { stack } = await chainStack()
    await secondGraph(stack)
    stack.bindingSource(stack.ledger({ ...DEPARTMENT, rootStoreId: rootTaskStoreId('s-root-2'), sourceTaskId: 't-other' }))
    const detail = expectRefused(await stack.service.taskRead('s-review'), 'cross-graph')
    expect(detail).toContain('never moves a session into another graph')
  })

  test('a delegation naming a task the store does not hold reads not-found', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger({ ...DEPARTMENT, sourceTaskId: 't-nope' }))
    const resolution = expectResolved(await stack.service.resolveCaller('s-review'))
    expect(resolution.kind).toBe('coordinator')
    if (resolution.kind !== 'coordinator') throw new Error('expected a coordinator')
    expect(resolution.task).toBeUndefined()
    expect(expectRefused(await stack.service.taskRead('s-review'), 'not-found')).toContain('t-nope')
  })

  test('a delegation whose session is not published is still placed by its store', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    const resolution = expectResolved(await stack.service.resolveCaller('s-unpublished-reviewer'))
    expect(resolution.kind).toBe('coordinator')
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
    expect(expectRefused(await stack.service.taskStatus('s-empty', { scope: 'graph' }), 'not-activated')).toContain(
      'task_intake',
    )
  })

  test('a store that exists with no root task answers the same named state', async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-held', rootSessionId: 's-held' })
    stack.sessionLog('s-held', ['a request nobody has contracted yet'])
    const storeId = rootTaskStoreId('s-held')
    await stack.task.createStore(storeId)
    expect(expectRefused(await stack.service.taskRead('s-held'), 'not-activated')).toContain(
      'opened, with no root task in it',
    )
  })
})

/**
 * Q1 (2026-09-25 rework): a request that cannot be bound must not come out
 * looking like a request from outside this deployment. Both refuse reads with a
 * name — that part never changed — but only the second may go on to assemble a
 * model request with nothing in it, so the resolution has to say which one it
 * is (`placement`). The distinction the rework fixes is exactly this:
 * a *failure* to read the facts a binding is derived from (the graph registry,
 * the domain store, the coordination ledger) is not the fact "no binding exists".
 */
describe('a binding failure is not "outside the deployment" (Q1)', () => {
  /** The placement of one refusal, on the resolution the assembly decides from. */
  async function placementOf(stack: FixtureStack, sessionId: string): Promise<string | undefined> {
    const resolution = await stack.service.resolveCaller(sessionId)
    if (resolution.kind !== 'unbound') throw new Error(`expected an unbound caller, got "${resolution.kind}"`)
    return resolution.placement
  }

  test('a session no graph publishes and no delegation binds is outside the deployment', async () => {
    const { stack } = await chainStack()
    const resolution = await stack.service.resolveCaller('s-stranger')
    expect(resolution.kind).toBe('unbound')
    if (resolution.kind !== 'unbound') throw new Error('expected unbound')
    expect(resolution.refusal).toBe('unbound')
    expect(resolution.placement).toBe('outside')
    expect(resolution.detail).toContain('not a published member of any graph')
  })

  test('a graph query that fails is a named read failure, never "no graph"', async () => {
    const { stack } = await chainStack()
    stack.breakGraphQuery(new Error('the graph registry store is corrupt'))
    const resolution = await stack.service.resolveCaller('s-g1')
    expect(resolution.kind).toBe('unbound')
    if (resolution.kind !== 'unbound') throw new Error('expected unbound')
    expect(resolution.refusal).toBe('unreadable')
    expect(resolution.placement).toBe('failed')
    expect(resolution.detail).toContain('the graph registry store is corrupt')
    // And the read the session would have made fails by name rather than
    // answering "this session belongs nowhere".
    expect(expectRefused(await stack.service.taskRead('s-g1'), 'unreadable')).not.toContain('not a published member')
  })

  test('a published member whose store cannot be read is a failure, not a member of an empty domain', async () => {
    const { stack } = await chainStack()
    // A store that exists (the log does) and cannot be opened: its graph's root
    // and a plain member of that graph both fail by name.
    stack.graph({ id: 'g-broken', rootSessionId: 's-broken-root', members: ['s-broken-member'] })
    stack.sessionLog('s-broken-member', ['a request'])
    stack.sessionLog(rootTaskStoreId('s-broken-root'), ['not a task store'])
    breakStoreLog(stack, rootTaskStoreId('s-broken-root'))
    expect(await placementOf(stack, 's-broken-member')).toBe('failed')
    expect(await placementOf(stack, 's-broken-root')).toBe('failed')
  })

  test("a store the backend reports as absent binds the root's not-activated state, a member's silence, and a spawned session's refusal", async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-no-store', rootSessionId: 's-no-store-root', members: ['s-no-store-member'] })
    // The root: a graph whose store does not exist yet is the named not-activated
    // state (A2 §D) — it is the one session that state belongs to.
    expect(expectRefused(await stack.service.taskRead('s-no-store-root'), 'not-activated')).toContain('task_intake')
    // A session the graph publishes without having spawned it (the real case is a
    // root of another graph a deployment resolves here): nothing to read, and the
    // member reading the plan gives it stays.
    expect(await stack.service.resolveCaller('s-no-store-member')).toMatchObject({ kind: 'member' })
    expect(
      expectRefused(await stack.service.taskStatus('s-no-store-member', { scope: 'graph' }), 'not-activated'),
    ).toContain('does not exist yet')
    // A session the graph *did* spawn: the run it is bound by was written to that
    // store when it was spawned, so an absent store is a store that cannot be
    // read — the state that once let a bound worker's request assemble with no
    // contract at all.
    stack.spawned('g-no-store', 's-no-store-worker')
    expect(await placementOf(stack, 's-no-store-worker')).toBe('failed')
    expect(expectRefused(await stack.service.taskRead('s-no-store-worker'), 'unreadable')).toContain(
      'was recorded in that store',
    )
    // And the graph store's own edge is what decides: if that read fails, the
    // question cannot be answered and the session is refused rather than guessed.
    stack.breakGraphView(new Error('the graph store is not readable'), 'g-no-store')
    expect(await placementOf(stack, 's-no-store-member')).toBe('failed')
  })

  test('a ledger that cannot answer one row is a failure for a published member', async () => {
    const { stack } = await chainStack()
    stack.bindingSource({
      read: async () => {
        throw new CoordinationBindingError('binding-conflict', 'two conflicting rows for one session')
      },
    })
    expect(await placementOf(stack, 's-review')).toBe('failed')
  })

  test('a delegation no graph can place is a failure, not a session from outside', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger({ ...DEPARTMENT, rootStoreId: 'sg-t-nobody' }))
    const resolution = await stack.service.resolveCaller('s-unpublished-reviewer')
    expect(resolution.kind).toBe('unbound')
    if (resolution.kind !== 'unbound') throw new Error('expected unbound')
    expect(resolution.placement).toBe('failed')
    expect(resolution.detail).toContain('sg-t-nobody')
  })
})

/**
 * Q2 (2026-09-25 rework): the ledger says who delegated a review, and that
 * delegation is what opens a graph's read domain to a session with no run of
 * its own — so the delegator has to be somebody the delegated graph actually
 * publishes. Nothing here trusts an id the model passed; the actor is the
 * ledger's own field, and the graph's membership is the registry's own view.
 */
describe('a delegation must come from a session of the graph it delegates into (Q2)', () => {
  test('a delegator the delegated graph publishes keeps the delegation, and the domain stays readable', async () => {
    const { stack, chain } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    const resolution = expectResolved(await stack.service.resolveCaller('s-review'))
    expect(resolution.kind).toBe('coordinator')
    // The whole delegated domain, not one task: the delegated task's contract,
    // the sibling's evidence and a session of the graph.
    expect(expectOk(await stack.service.taskRead('s-review')).text).toContain('review-only')
    expect(expectOk(await stack.service.contextRead('s-review', { kind: 'task', ref: 't-c1' })).text).toContain('t-c1')
    expect(expectOk(await stack.service.contextRead('s-review', { kind: 'evidence', ref: 'e-c2' })).text).toContain(
      'e-c2',
    )
    expect(expectOk(await stack.service.contextRead('s-review', { kind: 'session', ref: 's-c1' })).text).toContain(
      'child one',
    )
    expect(chain.storeId).toBe(DEPARTMENT.rootStoreId)
  })

  test('a delegator of another graph grants nothing: the review read is refused by name', async () => {
    const { stack } = await chainStack()
    const other = await secondGraph(stack)
    stack.bindingSource(stack.ledger({ ...DEPARTMENT, actor: 's-root-2' }))
    const detail = expectRefused(await stack.service.taskRead('s-review'), 'cross-graph')
    expect(detail).toContain('s-root-2')
    expect(detail).toContain('does not publish')
    // The delegated task, the other graph's task and the session history are all
    // out of reach: the refusal is not a narrower read, it is no domain at all.
    expect(
      expectRefused(await stack.service.contextRead('s-review', { kind: 'task', ref: 't-c1' }), 'cross-graph'),
    ).toContain('s-root-2')
    expect(
      expectRefused(await stack.service.contextRead('s-review', { kind: 'task', ref: other.taskId }), 'cross-graph'),
    ).toContain('s-root-2')
    expect(
      expectRefused(await stack.service.contextRead('s-review', { kind: 'session', ref: 's-c1' }), 'cross-graph'),
    ).toContain('s-root-2')
    expect(expectRefused(await stack.service.taskStatus('s-review'), 'cross-graph')).toContain('s-root-2')
  })

  test('a delegator no graph publishes is refused, and the refusal names it', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(stack.ledger({ ...DEPARTMENT, actor: 's-nobody' }))
    const detail = expectRefused(await stack.service.taskRead('s-review'), 'unbound')
    expect(detail).toContain('s-nobody')
    expect(detail).toContain('no graph in this deployment publishes')
  })

  test('a delegator check that cannot be read is refused as unreadable', async () => {
    const { stack, chain } = await chainStack()
    stack.bindingSource(stack.ledger(DEPARTMENT))
    stack.breakGraphView(new Error('the graph store is not readable'), chain.graph)
    const detail = expectRefused(await stack.service.taskRead('s-review'), 'unreadable')
    expect(detail).toContain('s-root')
    expect(detail).toContain('not readable')
  })
})
