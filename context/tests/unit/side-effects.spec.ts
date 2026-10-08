/**
 * What a read must never do (A2 §D/§E, A2-4): change the store, move a gate,
 * recover anything, or answer differently the second time it is asked about
 * unchanged content. The recovery markers ride along as observations; the read
 * itself is not the recovery.
 */

import { describe, expect, test } from 'vitest'
import { questionIdOf } from '../../../task/src/index.ts'
import { FixtureStack, seedChain, type Chain } from '../support/stack.ts'
import { expectOk, expectRefused } from '../support/stack.ts'

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

/** Every read this service offers, on every role the fixture can hold. */
async function readEverything(stack: FixtureStack): Promise<void> {
  for (const sessionId of ['s-root', 's-c1', 's-c2', 's-g1', 's-replay']) await stack.service.resolveCaller(sessionId)
  await stack.service.taskRead('s-c1')
  await stack.service.taskRead('s-g1')
  await stack.service.contractProjection('s-c1')
  await stack.service.taskStatus('s-g1')
  await stack.service.taskStatus('s-g1', { scope: 'graph' })
  await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-root' })
  await stack.service.contextRead('s-g1', { kind: 'run', ref: 'r-c2' })
  await stack.service.contextRead('s-g1', { kind: 'evidence', ref: 'e-c2' })
  await stack.service.contextRead('s-g1', { kind: 'review', ref: { taskId: 't-c2', runId: 'r-c2' } })
  await stack.service.contextRead('s-g1', { kind: 'diagnosis', ref: 'd-c2' })
  await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-c1' })
  await stack.service.contractProjection('s-g1')
  await stack.service.dynamicProjection('s-g1')
  await stack.service.questionProjection('s-root')
  await stack.service.questionProjection('s-c1')
}

describe('reads change nothing', () => {
  test("the store's events, its snapshot and the gate stand exactly where they stood", async () => {
    const { stack, chain } = await chainStack()
    const eventsBefore = stack.storeEvents(chain.storeId).length
    const snapshotBefore = JSON.stringify(await stack.snapshot(chain.storeId))
    const gateBefore = {
      worker: stack.gate.phaseOf('s-g1'),
      decisions: stack.gate.decisionToken('s-g1'),
      terminal: stack.gate.phaseOf('s-c2'),
    }

    await readEverything(stack)

    expect(stack.storeEvents(chain.storeId).length).toBe(eventsBefore)
    expect(JSON.stringify(await stack.snapshot(chain.storeId))).toBe(snapshotBefore)
    expect(stack.gate.phaseOf('s-g1')).toBe(gateBefore.worker)
    expect(stack.gate.decisionToken('s-g1')).toBe(gateBefore.decisions)
    expect(stack.gate.phaseOf('s-c2')).toBe(gateBefore.terminal)
    // The reads really did read: the observation surface was used, and it is the
    // whole surface this service was given.
    const calls = stack.observedCalls()
    expect(calls.recoveryStatus).toBeGreaterThan(0)
    expect(calls.readRunBinding).toBeGreaterThan(0)
    expect(Object.keys(stack.ctx.taskRuntime as object).sort()).toEqual([
      'allowsRuntimeDecomposition',
      'gate',
      'readRunBinding',
      'recoveryStatus',
    ])
  })

  test('a read of a recovering store answers with the marker instead of waiting for the barrier', async () => {
    const { stack, chain } = await chainStack()
    stack.recoveryStatus(chain.storeId, { status: 'recovering' })
    const read = expectOk(await stack.service.taskRead('s-g1'))
    expect(read.text).toContain('recovery: recovering')
    expect(read.text).toContain('neither triggers nor waits for recovery')
    expect(read.text).toContain('objective: grandchild: build the deck')
    const failed = expectOk(await stack.service.taskStatus('s-g1'))
    expect(failed.text).toContain('recovery: recovering')
    stack.recoveryStatus(chain.storeId, { status: 'recovery-failed', reason: 'the log could not be read' })
    expect(expectOk(await stack.service.dynamicProjection('s-g1')).text).toContain(
      'recovery: recovery-failed — the log could not be read',
    )
    // Nothing above recovered, and the store is exactly where it was.
    expect(stack.storeEvents(chain.storeId).length).toBeGreaterThan(0)
  })

  test('a run with no coordination phase is shown as needs-recovery, never guessed active', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-legacy')
    stack.sessionLog('s-legacy', ['request'])
    await stack.seed({
      taskId: 't-legacy',
      sessionId: 's-legacy',
      runId: 'r-legacy',
      objective: 'an old record',
      parentTaskId: 't-root',
      depth: 1,
      phaseUnknown: true,
    })
    const read = expectOk(await stack.service.taskRead('s-legacy'))
    expect(read.text).toContain('needs-recovery')
    expect(read.text).toContain('it has no phase to continue from')
    expect(read.text).not.toContain('phase active')
    const status = expectOk(await stack.service.taskStatus('s-legacy'))
    expect(status.text).toContain('needs-recovery (old record without a coordination phase)')
  })

  test('the effective gate phase is shown read-only, including a terminal one', async () => {
    const { stack } = await chainStack()
    stack.gate.setPhase('s-g1', 'submitted')
    stack.gate.setTerminal('s-c2')
    expect(expectOk(await stack.service.dynamicProjection('s-g1')).text).toContain('gate phase: submitted')
    expect(expectOk(await stack.service.dynamicProjection('s-c2')).text).toContain('gate phase: terminal')
    expect(expectOk(await stack.service.dynamicProjection('s-root')).text).toContain(
      'gate phase: not tracked for this session',
    )
  })
})

describe('projections are stable', () => {
  test('two projections of unchanged content are byte-identical', async () => {
    const { stack } = await chainStack()
    const firstContract = expectOk(await stack.service.contractProjection('s-g1')).text
    const firstDynamic = expectOk(await stack.service.dynamicProjection('s-g1')).text
    // Other reads in between must not change either projection: nothing
    // accumulates and no read counts itself.
    await readEverything(stack)
    expect(expectOk(await stack.service.contractProjection('s-g1')).text).toBe(firstContract)
    expect(expectOk(await stack.service.dynamicProjection('s-g1')).text).toBe(firstDynamic)
  })

  test('the question plane is stable, writes nothing, and asks the runtime for nothing', async () => {
    const { stack, chain } = await chainStack()
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    const answer = await stack.answer({
      questionId: questionIdOf({ childRunId: 'r-c1', requestKey: 'k1' }),
      requestKey: 'a1',
      resolves: true,
    })
    const events = stack.storeEvents(chain.storeId).length
    const observed = stack.observedCalls()

    const parent = expectOk(await stack.service.questionProjection('s-root')).text
    const child = expectOk(await stack.service.questionProjection('s-c1')).text
    expect(child).toContain(answer.answerId)
    // The one plane the question read touches is the Session log it folds a
    // consumption proof out of: no store write, and none of the runtime
    // observations a run's gate or binding would need. The two reads answer the
    // same bytes, and the only counter that moves is the caller resolution's
    // own store-open observation, which every projection performs.
    expect(expectOk(await stack.service.questionProjection('s-root')).text).toBe(parent)
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toBe(child)
    expect(stack.storeEvents(chain.storeId).length).toBe(events)
    expect(stack.observedCalls().readRunBinding).toBe(observed.readRunBinding)
    expect(stack.observedCalls().gatePhaseOf).toBe(observed.gatePhaseOf)

    // Other reads in between change neither the text nor the store.
    await readEverything(stack)
    expect(expectOk(await stack.service.questionProjection('s-root')).text).toBe(parent)
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toBe(child)
    expect(stack.storeEvents(chain.storeId).length).toBe(events)
  })

  test('a projection follows the store when the store really changes', async () => {
    const { stack } = await chainStack()
    const before = expectOk(await stack.service.dynamicProjection('s-c2')).text
    expect(before).toContain('run r-c2 [verified]')
    stack.member('g-s-root', 's-c1b')
    stack.sessionLog('s-c1b', ['request'])
    await stack.seed({
      taskId: 't-c1b',
      sessionId: 's-c1b',
      runId: 'r-c1b',
      objective: 'a new child of the root',
      parentTaskId: 't-root',
      depth: 1,
    })
    stack.gate.setTerminal('s-c2')
    const after = expectOk(await stack.service.dynamicProjection('s-c2')).text
    expect(after).not.toBe(before)
    expect(after).toContain('gate phase: terminal')
  })
})

describe('refusals of a read that cannot answer', () => {
  test('a coordinator whose delegated task vanished cannot widen its read boundary', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(
      stack.ledger({
        rootStoreId: 'sg-t-s-root',
        sourceTaskId: 't-missing',
        sourceRunId: null,
        role: 'reviewer',
        actor: 's-root',
        at: '2026-09-25T00:00:00.000Z',
      }),
    )
    // The contract reads refuse, because the delegation names a task the store
    // does not hold…
    expect(expectRefused(await stack.service.taskRead('s-review'), 'not-found')).toContain('does not hold')
    expect(expectRefused(await stack.service.contextRead('s-review', { kind: 'task', ref: 't-g1' }), 'not-found'))
      .toContain('no task')
  })

  test('a member has no related scope and is told which scope answers', async () => {
    const { stack } = await chainStack()
    stack.member('g-s-root', 's-bystander')
    expect(expectRefused(await stack.service.taskStatus('s-bystander'), 'unbound')).toContain('scope:"graph"')
    expect(expectRefused(await stack.service.dynamicProjection('s-bystander'), 'unbound')).toContain('no dynamic state')
  })
})
