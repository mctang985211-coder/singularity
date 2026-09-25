/**
 * What the reads answer (A2 §D/§9) on the fixture's real store: the caller's
 * contract and its root briefing, the handoff envelope, the related status, the
 * reference reads, the output bound, and the named refusals for a reference that
 * does not resolve.
 */

import { describe, expect, test } from 'vitest'
import { SESSION_QUERY_READ_WINDOW_MAX } from '@deepseek-ai/dsh-session-query'
import type { TaskProposalRoot, TaskSnapshot } from '../../../task/src/index.ts'
import { notActivatedLines, taskSummaryLine } from '../../src/index.ts'
import { FixtureStack, seedChain, type Chain } from '../support/stack.ts'
import { expectOk, expectRefused } from '../support/stack.ts'

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

/** The session plane as a seam: only the method a case replaces, typed structurally. */
interface SessionQuerySeam {
  readEvent(
    request: { readonly sessionId: string; readonly seq: number; readonly before?: number; readonly after?: number },
    signal?: AbortSignal,
  ): Promise<{ readonly target: unknown; readonly events: readonly unknown[]; readonly startSeq: number; readonly endSeq: number }>
}

/** One task whose summary line exceeds the whole output bound, with its index in the graph scope. */
async function seedOversizedStatusEntry(
  stack: FixtureStack,
  chain: Chain,
): Promise<{ taskId: string; index: number; lineBytes: number }> {
  const taskId = 't-m-bigstatus'
  // Read the scope first: without the oversized entry the page is complete, so
  // the index the entry will sort to is counted off the ids it must fall among.
  const before = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', limit: 100 }))
  const ids = [...before.text.matchAll(/^- (t-[a-z0-9-]+) /gm)].map(match => match[1] as string)
  const index = ids.filter(id => id < taskId).length
  stack.member(chain.graph, 's-worker-bigstatus')
  stack.sessionLog('s-worker-bigstatus', ['request'])
  await stack.seed({
    taskId,
    sessionId: 's-worker-bigstatus',
    runId: 'r-bigstatus',
    objective: 'z'.repeat(20_000),
    parentTaskId: 't-root',
    depth: 1,
  })
  const snapshot = await stack.snapshot(chain.storeId)
  const task = snapshot.tasks.find(item => item.taskId === taskId)
  if (task === undefined) throw new Error(`fixture: ${taskId} was not seeded`)
  return { taskId, index, lineBytes: Buffer.byteLength(taskSummaryLine(snapshot, task), 'utf8') }
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

  test('a window that fails after an earlier one succeeded is unreadable, never a partial page', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-flaky')
    // One window carries at most SESSION_QUERY_READ_WINDOW_MAX events, so a page
    // one event longer than that has to be collected from a second window.
    stack.sessionLog('s-flaky', Array.from({ length: SESSION_QUERY_READ_WINDOW_MAX + 1 }, (_, seq) => `event ${seq}`))
    const query = (stack.ctx as unknown as { sessionQuery: SessionQuerySeam }).sessionQuery
    const real = query.readEvent.bind(query)
    let calls = 0
    query.readEvent = async (request, signal) => {
      calls += 1
      if (calls > 1) throw new Error('the log stopped answering mid-read')
      return await real(request, signal)
    }
    const result = await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-flaky', limit: 100 })
    // The first window really did succeed — the failure is the second read — and
    // the events the first window carried are not handed back as a page.
    expect(calls).toBe(2)
    const detail = expectRefused(result, 'unreadable')
    expect(detail).toContain(`seq ${SESSION_QUERY_READ_WINDOW_MAX}`)
    expect(detail).toMatch(/nothing partial/i)
    expect('text' in result).toBe(false)
  })

  test('a window that answers without advancing is unreadable, never an empty page with more to come', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-stalled')
    stack.sessionLog('s-stalled', ['first', 'second'])
    const query = (stack.ctx as unknown as { sessionQuery: SessionQuerySeam }).sessionQuery
    query.readEvent = async request => ({ target: {}, events: [], startSeq: request.seq, endSeq: request.seq })
    // Nothing was read, so there is no page to report — an empty page here would
    // claim `hasMore` at the same offset and be read again forever.
    const detail = expectRefused(await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-stalled' }), 'unreadable')
    expect(detail).toContain('seq 0')
    expect(detail).toMatch(/advanc/)
  })

  test('an event larger than the bound is refused by name, never cut', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-big-event')
    stack.sessionLog('s-big-event', ['x'.repeat(20_000)])
    const result = await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-big-event', limit: 1 })
    // The refusal names the seq, the size of the event's own text, the fact that
    // an offset addresses whole events, and the one deliberate way past it.
    const detail = expectRefused(result, 'context-too-large')
    expect(detail).toContain('seq 0')
    expect(detail).toContain('20000')
    expect(detail).toMatch(/whole events/)
    expect(detail).toMatch(/offset 1\b/)
    // It is a refusal, not a page: no partial body of that event is returned.
    expect('text' in result).toBe(false)
    expect(detail).not.toContain('xxxx')
  })

  test('a page ends before an event that does not fit, and the next read refuses at that seq', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-mixed-events')
    stack.sessionLog('s-mixed-events', ['a short event', 'y'.repeat(20_000)])
    const page = expectOk(await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-mixed-events', limit: 2 }))
    expect(page.text).toContain('seq 0 | user/message')
    expect(page.text).not.toContain('yyy')
    // The page ends *before* the oversized event: the next offset is that
    // event's own seq, never seq+1, so the read skips nothing on its own.
    expect(page.hasMore).toBe(true)
    expect(page.nextOffset).toBe(1)
    expect(page.text).toMatch(/seq 1\b.*not shown/)
    expect(page.text).toContain('20000')
    // A follow-up read at that seq hits the whole-event refusal and names the one
    // offset that moves past it — the caller's choice, not the read's.
    const detail = expectRefused(
      await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-mixed-events', offset: 1, limit: 2 }),
      'context-too-large',
    )
    expect(detail).toContain('seq 1')
    expect(detail).toMatch(/offset 2\b/)
  })

  test('every successful page ends with its closing lines, whatever the next event measures', async () => {
    const { stack, chain } = await chainStack()
    // The shape an independent audit measured: a page whose first event nearly
    // fills the bound and then stops before a huge second one. Sizes sweep the
    // byte windows (≈15 988–16 049 and ≥ 16 134) in which the closing lines used
    // to fall outside the bound, leaving the model a page with no cue at all.
    for (const size of [15_600, 15_900, 15_988, 16_000, 16_049, 16_050, 16_100, 16_133, 16_134, 16_200, 16_390]) {
      const session = `s-size-${size}`
      stack.member(chain.graph, session)
      stack.sessionLog(session, ['A'.repeat(size), 'B'.repeat(20_000)])
      const result = await stack.service.contextRead('s-g1', { kind: 'session', ref: session, limit: 2 })
      if (!result.ok) {
        // A first event that cannot be carried is refused by name, never cut.
        expect(result.refusal, `size ${size}`).toBe('context-too-large')
        continue
      }
      // Whatever fitted, the page the model receives ends with where it stopped
      // and where to continue.
      expect(result.text, `size ${size}`).toContain('- events shown:')
      if (result.nextOffset === 1) {
        expect(result.text, `size ${size}`).toMatch(/the next event \(seq 1\b/)
        expect(result.text, `size ${size}`).toMatch(/more follows from seq 1\b/)
      }
    }
  })

  test('a session reference whose membership cannot be read is a named unreadable, not an escape', async () => {
    const { stack, chain } = await chainStack()
    // The registry's own view of who a graph publishes is a read like any other:
    // a session reference whose ownership cannot be established is refused by
    // name, never passed to DSH as if the session were the caller's.
    stack.breakGraphView(new Error('the graph store is not readable'), chain.graph)
    const detail = expectRefused(await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-c1' }), 'unreadable')
    expect(detail).toContain('membership of session "s-c1"')
    expect(detail).toContain('the graph store is not readable')
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

  test('a first entry over the bound is refused by name, with both ways forward', async () => {
    const { stack, chain } = await chainStack()
    const { taskId, index, lineBytes } = await seedOversizedStatusEntry(stack, chain)
    // The listing starts at the entry that cannot be shown: a page of zero
    // entries at this offset would report the same offset again, so it is a
    // refusal that names the entry and both ways past it.
    const result = await stack.service.taskStatus('s-g1', { scope: 'graph', offset: index, limit: 1 })
    const detail = expectRefused(result, 'context-too-large')
    expect(detail).toContain(taskId)
    expect(detail).toContain(String(lineBytes))
    expect(detail).toMatch(/same offset/)
    expect(detail).toContain('context_read')
    expect(detail).toContain('kind:"task"')
    expect(detail).toContain(`offset ${index + 1}`)
    // A refusal carries no continuation fields at all.
    expect(result).not.toHaveProperty('hasMore')
    expect(result).not.toHaveProperty('nextOffset')
  })

  test('a page that meets an over-bound entry stops before it, at that entry\'s own index', async () => {
    const { stack, chain } = await chainStack()
    const { taskId, index } = await seedOversizedStatusEntry(stack, chain)
    const page = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', offset: 0, limit: 100 }))
    const shownIds = [...page.text.matchAll(/^- (t-[a-z0-9-]+) /gm)].map(match => match[1] as string)
    // Every entry before the oversized one is shown — none is skipped for the one
    // that does not fit — and the page ends exactly at its index.
    expect(shownIds).not.toContain(taskId)
    expect(shownIds.length).toBe(index)
    expect(page.hasMore).toBe(true)
    expect(page.nextOffset).toBe(index)
    expect(page.nextOffset as number).toBeGreaterThan(0)
    // No cut summary line for it either: nothing of the entry is in the text.
    expect(page.text).not.toContain(taskId)
    expect(page.text).not.toContain('zzz')
    expect(page.text).toContain(`continue with offset ${index}`)
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

  test('a non-finite offset or limit is clamped like any other out-of-range value', async () => {
    const { stack } = await chainStack()
    // Not reachable through the tool door (its schema rejects a non-number), but
    // the service door is a door: an unpageable number must not produce the one
    // page shape a reader can never continue from.
    const page = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', offset: Number.NaN, limit: Number.NaN }))
    expect(page.text).toContain('clamped into their ranges')
    // A page is either finished or it advances: the shape `hasMore` with the same
    // offset back is the one a reader can never leave.
    expect(page.nextOffset as number).toBeGreaterThan(0)
    expect(page.hasMore === true && page.nextOffset === 0).toBe(false)
    const infinite = expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph', offset: 0, limit: Number.POSITIVE_INFINITY }))
    expect(infinite.text).toContain('limit 20')
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

/**
 * The decomposition guidance in the worker's contract projection (A2, migrated
 * from the old spawn prompt's conditional rules): the decomposable block when
 * the task was admitted to split, the runtime-split rule when the deployment
 * admits a run's own decomposition, the review-wait rule behind either, and
 * never any of it for a replay or a reviewer. The unconditional rules are the
 * agent runtime's worker policy section — the projection does not repeat them.
 */
describe('the decomposition guidance in the contract projection', () => {
  test('a decomposable task reads its own block and the review rule, without the runtime-split door when the switch is off', async () => {
    const stack = new FixtureStack()
    stack.graph({ id: 'g-x', rootSessionId: 's-xroot', members: ['s-xw'] })
    stack.sessionLog('s-xroot', ['request'])
    stack.sessionLog('s-xw', ['request'])
    stack.runtimeDecomposition = false
    await stack.seed({ taskId: 't-xroot', sessionId: 's-xroot', runId: 'r-xroot', objective: 'the root goal' })
    await stack.seed({
      taskId: 't-xw',
      sessionId: 's-xw',
      runId: 'r-xw',
      objective: 'the decomposable child',
      parentTaskId: 't-xroot',
      depth: 1,
      decomposable: true,
    })
    const text = expectOk(await stack.service.contractProjection('s-xw')).text
    expect(text).toContain('## This task is decomposable')
    expect(text).toContain('was admitted as decomposable')
    expect(text).toContain('`task_decompose`')
    expect(text).toContain('RFC §36')
    expect(text).toContain('the nested verification settles this task')
    expect(text).toContain('waiting for a human review')
    expect(text).toContain('`task_proposal_read`')
    expect(text).toContain('a revision is a new proposal')
    expect(text).not.toContain('## If the work turns out not to be atomic')
    expect(text).not.toContain('admits a task\'s own decomposition')
  })

  test('a leaf worker reads the runtime-split rule and the review rule when the deployment admits it, and neither when it does not', async () => {
    const stack = new FixtureStack()
    const chain = await seedChain(stack)

    const on = expectOk(await stack.service.contractProjection('s-c1')).text
    expect(on).toContain('## If the work turns out not to be atomic')
    expect(on).toContain('admits a task\'s own decomposition')
    expect(on).toContain('a refusal names the rule that blocked it')
    expect(on).toContain('a task may split only once')
    expect(on).toContain('waiting for a human review')
    expect(on).not.toContain('## This task is decomposable')

    stack.runtimeDecomposition = false
    const off = expectOk(await stack.service.contractProjection('s-c1')).text
    expect(off).not.toContain('task_decompose')
    expect(off).not.toContain('decompos')
    expect(off).not.toContain('waiting for a human review')

    // A replay re-runs the one task as contracted: no decomposition guidance
    // whatever the switch says.
    stack.runtimeDecomposition = true
    const replay = expectOk(await stack.service.contractProjection(chain.replaySession)).text
    expect(replay).not.toContain('## This task is decomposable')
    expect(replay).not.toContain('## If the work turns out not to be atomic')
    expect(replay).not.toContain('waiting for a human review')
  })

  test('the unconditional worker rules are the agent runtime\'s policy section, not this projection', async () => {
    const stack = new FixtureStack()
    await seedChain(stack)
    const text = expectOk(await stack.service.contractProjection('s-c1')).text
    // One rule, one home: the stable policy (submission, idle, self-check) is
    // not repeated in the projection the contract owns.
    expect(text).not.toContain('Going idle is not a submission')
    expect(text).not.toContain('`task_verify` is only a self-check')
    expect(text).not.toContain('never declare completion yourself — an external verifier')
  })
})
