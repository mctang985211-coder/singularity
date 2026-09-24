/**
 * What the reads answer (A2 §D/§9) on the fixture's real store: the caller's
 * contract and its root briefing, the handoff envelope, the related status, the
 * reference reads, the output bound, and the named refusals for a reference that
 * does not resolve.
 */

import { describe, expect, test } from 'vitest'
import type { TaskProposalRoot, TaskSnapshot } from '../../../task/src/index.ts'
import { notActivatedLines } from '../../src/index.ts'
import { FixtureStack, seedChain, type Chain } from '../support/stack.ts'
import { expectOk, expectRefused } from '../support/stack.ts'

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

/** The body of a task-record page: the record text between the banner and the continuation footer. */
function pageBody(text: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf('', 2)
  const end = lines.lastIndexOf('')
  return lines.slice(start + 1, end).join('\n')
}

describe('the caller\'s contract and its root briefing', () => {
  test('a three-layer worker reads the root objective and its hard constraints, its own contract, and the handoff', async () => {
    const { stack } = await chainStack()
    const projection = expectOk(await stack.service.contractProjection('s-g1'))
    const text = projection.text

    // The root briefing is the top of the real parent chain: the root's
    // objective and the constraints its contract carries.
    expect(text).toContain('## Root objective and hard constraints')
    expect(text).toContain('t-root [running]: build the release')
    expect(text).toContain('never rewrite the accepted contract')
    expect(text).toContain('keep the public API stable')
    // The worker's own contract: objective, criteria with protected inputs.
    expect(text).toContain('objective: grandchild: build the deck')
    expect(text).toContain('t-g1-c1 [deterministic, mandatory]')
    expect(text).toContain('[protected inputs: spec/t-g1.json]')
    // The handoff envelope: reason, decisions, assumptions, open questions.
    expect(text).toContain('reason for delegation: the deck is a separate deliverable')
    expect(text).toContain('decisions already made:')
    expect(text).toContain('deck material decided')
    expect(text).toContain('assumptions:')
    expect(text).toContain('the truss is verified')
    // The parent session is offered as a context_read reference and by no other
    // name: the raw cross-session tools are not a Singularity entry.
    expect(text).toContain('context_read` kind:"session" ref:"s-c1"')
    expect(text).not.toContain('session_event_read')
    expect(text).not.toContain('session_trace')
  })

  test('a worker\'s own run carries its phase and its bound content, re-checked by name', async () => {
    const { stack } = await chainStack()
    const read = expectOk(await stack.service.taskRead('s-c1'))
    expect(read.text).toContain('objective: child one: build the bridge')
    expect(read.text).toContain('run r-c1 [running] — phase active')
    expect(read.text).toContain('## Implementation chosen for this run')
    // The binding's snapshot is reported as unreadable rather than silently
    // standing in for the production path.
    expect(read.text).toContain('Bound content is not readable')
    expect(read.text).toContain('content-mismatch')
    expect(read.source).toContain('store sg-t-s-root')
  })

  test('a replay task\'s briefing is its own objective, never the root\'s', async () => {
    const { stack, chain } = await chainStack()
    const text = expectOk(await stack.service.contractProjection(chain.replaySession)).text
    expect(text).toContain('role: replay')
    expect(text).toContain('replay lineage')
    expect(text).toContain('parent run r-root')
    expect(text).toContain('objective: replay the champion candidate')
    // The store's other parentless task is the root; its objective is not
    // adopted as this replay's briefing.
    expect(text).not.toContain('build the release')
    expect(expectOk(await stack.service.taskRead(chain.replaySession)).text).toContain('replay the champion candidate')
  })

  test('an accepted root reads its own root contract', async () => {
    const { stack } = await chainStack()
    const text = expectOk(await stack.service.taskRead('s-root')).text
    expect(text).toContain('objective: build the release')
    expect(text).toContain('never rewrite the accepted contract')
    expect(text).toContain('children: 2')
    expect(text).toContain('t-c1')
  })
})

describe('reading a sibling dependency by reference', () => {
  test('the grandchild reads its dependency\'s evidence and review, and the dependency is the one that blocks it', async () => {
    const { stack } = await chainStack()
    const evidence = expectOk(await stack.service.contextRead('s-g1', { kind: 'evidence', ref: 'e-c2' }))
    expect(evidence.text).toContain('evidence e-c2 of task t-c2 (run r-c2)')
    expect(evidence.text).toContain('a-truss')
    const review = expectOk(await stack.service.contextRead('s-g1', { kind: 'review', ref: { taskId: 't-c2', runId: 'r-c2' } }))
    expect(review.text).toContain('review of task t-c2 (run r-c2) [verified]')
    const status = expectOk(await stack.service.taskStatus('s-g1'))
    expect(status.text).toContain('t-c2')
    expect(status.text).toContain('dependency (blocks you)')
    expect(status.text).toContain('you')
  })

  test('the default view leaves unrelated history out, while the graph scope still offers it', async () => {
    const { stack } = await chainStack()
    const related = expectOk(await stack.service.taskStatus('s-g1')).text
    expect(related).toContain('t-g1')
    expect(related).toContain('t-c2')
    // The root, the parent and the unrelated replay task are not the caller's
    // own, its children, or its direct dependencies.
    expect(related).not.toContain('t-root')
    expect(related).not.toContain('t-c1')
    expect(related).not.toContain('t-replay')
    expect(related).toContain('one read of store sg-t-s-root')
    expect(related).toContain('not a consistent snapshot')
    const graph = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph' })).text
    for (const taskId of ['t-root', 't-c1', 't-c2', 't-g1', 't-replay']) expect(graph).toContain(taskId)
    // The same records are readable by reference, which is what keeps the
    // default view a projection rather than an authorization.
    expect(expectOk(await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-root' })).text).toContain('build the release')
  })

  test('a run and a diagnosis are readable by their own ids', async () => {
    const { stack } = await chainStack()
    const run = expectOk(await stack.service.contextRead('s-g1', { kind: 'run', ref: 'r-c2' }))
    expect(run.text).toContain('run r-c2 of task t-c2 [verified]')
    expect(run.text).toContain('session: s-c2')
    const diagnosis = expectOk(await stack.service.contextRead('s-g1', { kind: 'diagnosis', ref: 'd-c2' }))
    expect(diagnosis.text).toContain('diagnosis d-c2 of task t-c2')
    expect(diagnosis.text).toContain('a fixture cause')
  })

  test('a review of a task that blocked before any run is read by its pair with runId null', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-blocked')
    stack.sessionLog('s-blocked', ['request'])
    await stack.seedBlockedWithoutRun({
      taskId: 't-blocked',
      sessionId: 's-blocked',
      objective: 'a task that never ran',
      reason: 'dependency t-c2 did not verify',
    })
    const review = expectOk(await stack.service.contextRead('s-c1', { kind: 'review', ref: { taskId: 't-blocked', runId: null } }))
    expect(review.text).toContain('(no run — the task blocked before any run started) [blocked]')
    expect(review.text).toContain('dependency t-c2 did not verify')
  })
})

describe('references that do not resolve', () => {
  test('an unknown id is not-found, and a review reference naming the wrong run is stale', async () => {
    const { stack } = await chainStack()
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-nope' }), 'not-found'))
      .toContain('no task "t-nope"')
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'run', ref: 'r-nope' }), 'not-found'))
      .toContain('no run "r-nope"')
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'evidence', ref: 'e-nope' }), 'not-found'))
    // t-c2 has a review, but not for this run: the reference is stale, and the
    // refusal names the reviews the store does hold.
    const stale = expectRefused(
      await stack.service.contextRead('s-g1', { kind: 'review', ref: { taskId: 't-c2', runId: 'r-elsewhere' } }),
      'stale-reference',
    )
    expect(stale).toContain('t-c2#r-c2')
    // A task with no review at all names nothing.
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'review', ref: { taskId: 't-g1', runId: null } }), 'not-found'))
      .toContain('has no review record')
    // A malformed reference names no record either, and says which shape is expected.
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'review', ref: 't-c2' }), 'not-found'))
      .toContain('{taskId, runId}')
  })

  test('a not-activated domain holds no record to read, and says so', async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-empty', rootSessionId: 's-empty' })
    stack.sessionLog('s-empty', ['request'])
    expect(expectRefused(await stack.service.contextRead('s-empty', { kind: 'task', ref: 't-any' }), 'not-activated'))
      .toContain('does not exist yet')
  })
})

describe('the output bound', () => {
  test('a record over the bound pages in UTF-8 bytes, never splitting a character', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-worker-big')
    stack.sessionLog('s-worker-big', ['request'])
    const objective = `验收标准 ${'x'.repeat(4_000)} 结束`
    await stack.seed({
      taskId: 't-big',
      sessionId: 's-worker-big',
      runId: 'r-big',
      objective,
      parentTaskId: 't-root',
      depth: 1,
    })

    const whole = expectOk(await stack.service.contextRead('s-worker-big', { kind: 'task', ref: 't-big' }))
    expect(whole.hasMore).toBe(false)
    const record = pageBody(whole.text)

    // A 256-byte page: read to the end, and the pages must be exactly the
    // record, with no replacement character anywhere.
    let offset = 0
    let pages = 0
    const joined: string[] = []
    for (;;) {
      const page = expectOk(await stack.service.contextRead('s-worker-big', { kind: 'task', ref: 't-big', offset, limit: 256 }))
      const body = pageBody(page.text)
      expect(body).not.toContain('\uFFFD')
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(256)
      joined.push(body)
      pages += 1
      if (page.hasMore !== true) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset as number
      expect(pages).toBeLessThan(500)
    }
    expect(pages).toBeGreaterThan(1)
    expect(joined.join('')).toBe(record)
    // The offset a page reports is on a character boundary: the tail from it
    // starts a complete character.
    expect(record.includes('结束')).toBe(true)
  })

  test('a core contract over the bound is refused as context-too-large, never cut', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-worker-huge')
    stack.sessionLog('s-worker-huge', ['request'])
    await stack.seed({
      taskId: 't-huge',
      sessionId: 's-worker-huge',
      runId: 'r-huge',
      objective: `a huge contract ${'y'.repeat(20_000)}`,
      parentTaskId: 't-root',
      depth: 1,
    })
    expect(expectRefused(await stack.service.taskRead('s-worker-huge'), 'context-too-large')).toContain('context_read')
    expect(expectRefused(await stack.service.contractProjection('s-worker-huge'), 'context-too-large')).toContain('16384-byte output bound')
    // The same record is still readable in pages, with a continuation.
    const first = expectOk(await stack.service.contextRead('s-worker-huge', { kind: 'task', ref: 't-huge' }))
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBeGreaterThan(0)
    // Nothing in the text claims the record is complete.
    expect(first.text).toContain('more of this record follows')
  })

  test('a session pages by DSH event offset and reports the next one', async () => {
    const { stack } = await chainStack()
    const first = expectOk(await stack.service.contextRead('s-c1', { kind: 'session', ref: 's-c1', limit: 1 }))
    expect(first.text).toContain('# context_read session s-c1')
    expect(first.text).toContain('seq 0 | user/message')
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(1)
    const second = expectOk(await stack.service.contextRead('s-c1', { kind: 'session', ref: 's-c1', offset: first.nextOffset, limit: 1 }))
    expect(second.text).toContain('seq 1 | user/message')
    expect(second.hasMore).toBe(false)
    // Past the end is an empty page, not a refusal.
    const past = expectOk(await stack.service.contextRead('s-c1', { kind: 'session', ref: 's-c1', offset: 99 }))
    expect(past.text).toContain('at or past the end of the log')
    expect(past.hasMore).toBe(false)
  })
})

describe('task_status pagination', () => {
  test('entries sort by task id, offset and limit page them, and the tail says there is no more', async () => {
    const { stack } = await chainStack()
    const first = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', limit: 2 }))
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(2)
    const ids = [...first.text.matchAll(/^- (t-[a-z0-9]+) /gm)].map(match => match[1])
    expect(ids).toEqual(['t-c1', 't-c2'])
    const second = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', offset: 2, limit: 2 }))
    const secondIds = [...second.text.matchAll(/^- (t-[a-z0-9]+) /gm)].map(match => match[1])
    expect(secondIds).toEqual(['t-g1', 't-replay'])
    expect(second.hasMore).toBe(true)
    expect(second.nextOffset).toBe(4)
    const last = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', offset: 4, limit: 2 }))
    expect([...last.text.matchAll(/^- (t-[a-z0-9]+) /gm)].map(match => match[1])).toEqual(['t-root'])
    expect(last.hasMore).toBe(false)
    expect(last.text).toContain('this is the end of the scope')
    // An offset past the end is an empty page, not a refusal.
    const past = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', offset: 50 }))
    expect(past.hasMore).toBe(false)
    expect(past.text).toContain('this is the end of the scope')
  })

  test('a limit outside 1–100 is clamped, and the result says so', async () => {
    const { stack } = await chainStack()
    const clamped = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', limit: 1_000 }))
    expect(clamped.text).toContain('limit 100 (requested offset 0, limit 1000: both are clamped into their ranges)')
    const zero = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', limit: 0 }))
    expect(zero.text).toContain('limit 1')
    const negative = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', offset: -5, limit: 2 }))
    expect(negative.text).toContain('offset 0')
    const inRange = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', limit: 3 }))
    expect(inRange.text).toContain('scope: graph · offset 0 · limit 3')
    expect(inRange.text).not.toContain('clamped')
  })

  test('the related scope from a reviewer covers the delegated task\'s relations', async () => {
    const { stack } = await chainStack()
    stack.bindingSource(
      stack.ledger({ rootStoreId: 'sg-t-s-root', taskId: 't-c1', actor: 's-root', at: '2026-09-25T00:00:00.000Z' }),
    )
    const text = expectOk(await stack.service.taskStatus('s-review')).text
    expect(text).toContain('t-c1')
    expect(text).toContain('t-g1')
    expect(text).not.toContain('t-c2')
  })
})

describe('the obligation footer', () => {
  test('an absent env builder omits the coverage line rather than failing a read', async () => {
    const { stack } = await chainStack()
    await stack.oblige({ obligationId: 'o-1', taskId: 't-c2', sessionId: 's-c2' })
    const text = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph' })).text
    expect(text).toContain('- obligations: 1 recorded')
    expect(text).not.toContain('obligation coverage')
  })

  test('a mounted env builder with no discoverable templates still reports the count', async () => {
    const { stack } = await chainStack()
    await stack.oblige({ obligationId: 'o-1', taskId: 't-c2', sessionId: 's-c2' })
    stack.mountEnvBuilder()
    const text = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph' })).text
    expect(text).toContain('- obligations: 1 recorded')
  })
})

describe('the not-activated view', () => {
  test('lists the open root proposal, its meaning and the intake that changes it', () => {
    const proposal = {
      kind: 'root',
      proposalId: 'p-fixture',
      status: 'pending_review',
      policy: 'off',
    } as unknown as TaskProposalRoot
    const snapshot = {
      version: 1,
      id: 'sg-t-s-empty',
      tasks: [],
      runs: [],
      edges: [],
      evidence: [],
      handoffs: [],
      reviews: [],
      diagnoses: [],
      obligations: [],
      capabilities: {},
      proposals: { all: [proposal], byId: { 'p-fixture': proposal }, byRequestKey: {}, byParentTask: {} },
    } as unknown as TaskSnapshot
    const text = notActivatedLines(
      { id: 'g-empty', name: 'g-empty', envId: 'env-empty', rootSessionId: 's-empty' },
      'sg-t-s-empty',
      snapshot,
    ).join('\n')
    expect(text).toContain('p-fixture [pending_review] policy off — waiting for a review decision')
    expect(text).toContain('task_intake')
    expect(text).toContain('no objective is reported here')
  })
})
