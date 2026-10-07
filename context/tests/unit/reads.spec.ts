/**
 * What the reads answer (A2 §D/§9) on the fixture's real store: the caller's
 * contract and its root briefing, the handoff envelope, the related status, the
 * reference reads, the output bound, and the named refusals for a reference that
 * does not resolve.
 */

import { describe, expect, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SESSION_QUERY_READ_WINDOW_MAX, extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { TaskProposalRoot, TaskSnapshot } from '../../../task/src/index.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, notActivatedLines, taskSummaryLine } from '../../src/index.ts'
import { FixtureStack, seedChain, type Chain } from '../support/stack.ts'
import { expectOk, expectRefused } from '../support/stack.ts'

/** The smallest fixture that is really over the bound: the bound plus a few KB. */
const OVER_BOUND_BYTES = CONTEXT_OUTPUT_LIMIT_BYTES + 5_000

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

test('supervisor context preserves its coordination responsibility and exact source Run', async () => {
  const { stack } = await chainStack()
  stack.bindingSource(stack.ledger({
    rootStoreId: 'sg-t-s-root', taskId: 't-c1', actor: 's-root', at: '2026-10-07T00:00:00.000Z',
    role: 'supervisor', sourceRunId: 'r-c1',
  }))
  const contract = expectOk(await stack.service.contractProjection('s-review')).text
  expect(contract).toContain('role: supervisor')
  expect(contract).toContain('method supervision, no business Run')
  expect(contract).toContain('exact source Run: r-c1')
  expect(contract).not.toContain('## Guidance loaded for this run')
  expect(expectOk(await stack.service.taskRead('s-review')).text).toContain('method supervision')
})

test('a missing exact coordination source Run is refused instead of falling back to the latest Run', async () => {
  const { stack } = await chainStack()
  stack.bindingSource(stack.ledger({
    rootStoreId: 'sg-t-s-root', taskId: 't-c1', actor: 's-root', at: '2026-10-07T00:00:00.000Z',
    role: 'supervisor', sourceRunId: 'r-missing',
  }))
  expect(expectRefused(await stack.service.contractProjection('s-review'), 'not-found')).toContain('r-missing')
})

/** The session plane as a seam: only the method a case replaces, typed structurally. */
interface SessionQuerySeam {
  readEvent(
    request: { readonly sessionId: string; readonly seq: number; readonly before?: number; readonly after?: number },
    signal?: AbortSignal,
  ): Promise<{
    readonly target: unknown
    readonly events: readonly unknown[]
    readonly startSeq: number
    readonly endSeq: number
  }>
}

/** One task whose summary line exceeds the whole output bound, with its index in the graph scope. */
async function seedOversizedStatusEntry(
  stack: FixtureStack,
  chain: Chain,
): Promise<{ taskId: string; index: number; lineBytes: number }> {
  const taskId = 't-m-bigstatus'
  // Read the scope first: without the oversized entry the page is complete, so
  // the index the entry will sort to is counted off the ids it must fall among.
  const before = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', limit: 100 }))
  const ids = [...before.text.matchAll(/^- (t-[a-z0-9-]+) /gm)].map(match => match[1] as string)
  const index = ids.filter(id => id < taskId).length
  stack.member(chain.graph, 's-worker-bigstatus')
  stack.sessionLog('s-worker-bigstatus', ['request'])
  await stack.seed({
    taskId,
    sessionId: 's-worker-bigstatus',
    runId: 'r-bigstatus',
    objective: 'z'.repeat(OVER_BOUND_BYTES),
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

/** One session-event page, in the shape the read fixes: the JSON a model receives, decoded. */
interface EventPage {
  readonly sessionId: string
  readonly seq: number
  readonly offset: number
  readonly nextOffset: number
  readonly hasMore: boolean
  readonly body: string
  readonly note?: string
}

/** The session plane as a seam, for the one-event shape an event read renders. */
interface SessionEventSeam {
  readEvent(
    request: { readonly sessionId: string; readonly seq: number; readonly before?: number; readonly after?: number },
    signal?: AbortSignal,
  ): Promise<{ readonly target: SessionEvent }>
}

/** A second graph in the same deployment: another root session, another store, the same cwd. */
async function secondGraph(stack: FixtureStack): Promise<{ rootSession: string }> {
  stack.graph({ id: 'g-2', rootSessionId: 's-root-2', members: [] })
  stack.sessionLog('s-root-2', ['second graph request'])
  await stack.seed({
    taskId: 't-other',
    sessionId: 's-root-2',
    runId: 'r-other',
    objective: 'the other graph objective',
  })
  return { rootSession: 's-root-2' }
}

/** The event the fixture's log holds at `seq`, as the session query answers it. */
async function loggedEvent(stack: FixtureStack, sessionId: string, seq: number): Promise<SessionEvent> {
  const query = (stack.ctx as unknown as { sessionQuery: SessionEventSeam }).sessionQuery
  return (await query.readEvent({ sessionId, seq, before: 0, after: 0 })).target
}

/** Count the event reads one case performs, so "refused before DSH" is measured rather than assumed. */
function trackEventReads(stack: FixtureStack): { reads: number } {
  const counter = { reads: 0 }
  const query = (stack.ctx as unknown as { sessionQuery: SessionQuerySeam }).sessionQuery
  const real = query.readEvent.bind(query)
  query.readEvent = async (request, signal) => {
    counter.reads += 1
    return await real(request, signal)
  }
  return counter
}

/** Decode one event page. */
function eventPage(text: string): EventPage {
  return JSON.parse(text) as EventPage
}

/**
 * Walk one event's text page by page and hand back what the pages carried: every
 * page is checked against the output bound and against the page that follows, so
 * a walk that returns has really advanced to the end of the text.
 */
async function walkEvent(
  stack: FixtureStack,
  caller: string,
  sessionId: string,
  seq: number,
  limit?: number,
): Promise<{ text: string; pages: number }> {
  let offset = 0
  let pages = 0
  const parts: string[] = []
  for (;;) {
    const result = expectOk(
      await stack.service.contextRead(caller, {
        kind: 'session',
        ref: { sessionId, seq },
        offset,
        ...(limit === undefined ? {} : { limit }),
      }),
    )
    const page = eventPage(result.text)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
    expect(page.offset).toBe(offset)
    expect(page.hasMore).toBe(result.hasMore)
    expect(page.nextOffset).toBe(result.nextOffset)
    parts.push(page.body)
    pages += 1
    if (result.hasMore !== true) break
    expect(result.nextOffset as number).toBeGreaterThan(offset)
    offset = result.nextOffset as number
    expect(pages).toBeLessThan(20_000)
  }
  return { text: parts.join(''), pages }
}

describe("the caller's contract and its root briefing", () => {
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

  test("a worker's own run carries its phase and its bound content, re-checked by name", async () => {
    const stack = new FixtureStack()
    await seedChain(stack, 's-root', true)
    const read = expectOk(await stack.service.taskRead('s-c1'))
    expect(read.text).toContain('objective: child one: build the bridge')
    expect(read.text).toContain('run r-c1 [running] — phase active')
    expect(read.text).toContain('## Implementation chosen for this run')
    // The binding's snapshot is reported as unreadable rather than silently
    // standing in for the production path.
    expect(read.text).toContain('Bound content is not readable')
    expect(read.text).toContain('content-mismatch')
    expect(read.source).toContain('store sg-t-s-root')
    await stack.task.markRunStatusIn('sg-t-s-root', 't-c1', 'r-c1', 'cancelled', 's-root', { reason: 'historical run stopped by its owner' })
    const historical = expectOk(await stack.service.contextRead('s-root', { kind: 'run', ref: 'r-c1' })).text
    expect(historical).toContain('run r-c1 of task t-c1 [cancelled]')
    expect(historical).toContain('content-mismatch')
    stack.bindingSource(stack.ledger({ rootStoreId: 'sg-t-s-root', taskId: 't-c1', actor: 's-root', at: '2026-09-25T00:00:00.000Z' }))
    const reviewed = expectOk(await stack.service.contractProjection('s-review')).text
    expect(reviewed).toContain('objective: child one: build the bridge')
    expect(reviewed).toContain('no business Run')
    expect(expectOk(await stack.service.contextRead('s-review', { kind: 'run', ref: 'r-c1' })).text).toContain('content-mismatch')
    expect(expectRefused(await stack.service.contractProjection('s-c1'), 'unreadable')).toContain('content-mismatch')
  })

  test("a replay task's briefing is its own objective, never the root's", async () => {
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
  test("the grandchild reads its dependency's evidence and review, and the dependency is the one that blocks it", async () => {
    const { stack } = await chainStack()
    const evidence = expectOk(await stack.service.contextRead('s-g1', { kind: 'evidence', ref: 'e-c2' }))
    expect(evidence.text).toContain('evidence e-c2 of task t-c2 (run r-c2)')
    expect(evidence.text).toContain('a-truss')
    const review = expectOk(
      await stack.service.contextRead('s-g1', { kind: 'review', ref: { taskId: 't-c2', runId: 'r-c2' } }),
    )
    expect(review.text).toContain('review of task t-c2 (run r-c2) [verified]')
    const status = expectOk(await stack.service.taskStatus('s-g1'))
    expect(status.text).toContain('t-c2')
    expect(status.text).toContain('dependency (blocks you)')
    expect(status.text).toContain('you')
  })

  test('workers retain ancestors and dependencies while the root can inspect unrelated history', async () => {
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
    for (const taskId of ['t-root', 't-c1', 't-c2', 't-g1']) expect(graph).toContain(taskId)
    expect(graph).not.toContain('t-replay')
    const root = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph' })).text
    expect(root).toContain('t-replay')
    // Ancestor context remains available inside the worker read boundary.
    expect(expectOk(await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-root' })).text).toContain(
      'build the release',
    )
  })

  test('a run and a diagnosis are readable by their own ids', async () => {
    const { stack } = await chainStack()
    const run = expectOk(await stack.service.contextRead('s-g1', { kind: 'run', ref: 'r-c2' }))
    expect(run.text).toContain('run r-c2 of task t-c2 [verified]')
    expect(run.text).toContain('session: s-c2')
    const diagnosis = expectOk(await stack.service.contextRead('s-g1', { kind: 'diagnosis', ref: 'd-c2' }))
    expect(diagnosis.text).toContain('diagnosis d-c2 of task t-c2')
    // The persisted `observedFailure` slot is read as the postmortem observation
    // it is (A5): a diagnosis is what was observed, whether or not it failed.
    expect(diagnosis.text).toContain('postmortem observation: fixture failure')
    expect(diagnosis.text).toContain('a fixture cause')

    // A diagnosis read back as the record holds it (A5 §3): no judgements when
    // the reviewer made none, and a suggestion whose target type is outside the
    // nine the store used to freeze.
    await stack.diagnose({
      taskId: 't-c2',
      diagnosisId: 'd-open',
      sessionId: 's-c2',
      evidenceRefs: ['e-c2'],
      observedFailure: 'the run passed every mandatory criterion',
      proposals: [{ targetType: 'prompt_template', targetId: 'reviewer', rationale: 'name the empty-input case' }],
    })
    const open = expectOk(await stack.service.contextRead('s-g1', { kind: 'diagnosis', ref: 'd-open' }))
    expect(open.text).toContain('the run passed every mandatory criterion')
    expect(open.text).toContain('"targetType": "prompt_template"')
    expect(open.text).not.toContain('judgements')
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
    const review = expectOk(
      await stack.service.contextRead('s-root', { kind: 'review', ref: { taskId: 't-blocked', runId: null } }),
    )
    expect(review.text).toContain('(no run — the task blocked before any run started) [blocked]')
    expect(review.text).toContain('dependency t-c2 did not verify')
  })
})

describe('references that do not resolve', () => {
  test('an unknown id is not-found, and a review reference naming the wrong run is stale', async () => {
    const { stack } = await chainStack()
    expect(
      expectRefused(await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-nope' }), 'not-found'),
    ).toContain('no task "t-nope"')
    expect(
      expectRefused(await stack.service.contextRead('s-g1', { kind: 'run', ref: 'r-nope' }), 'not-found'),
    ).toContain('no run "r-nope"')
    expect(expectRefused(await stack.service.contextRead('s-g1', { kind: 'evidence', ref: 'e-nope' }), 'not-found'))
    // t-c2 has a review, but not for this run: the reference is stale, and the
    // refusal names the reviews the store does hold.
    const stale = expectRefused(
      await stack.service.contextRead('s-g1', { kind: 'review', ref: { taskId: 't-c2', runId: 'r-elsewhere' } }),
      'stale-reference',
    )
    expect(stale).toContain('t-c2#r-c2')
    // A task with no review at all names nothing.
    expect(
      expectRefused(
        await stack.service.contextRead('s-g1', { kind: 'review', ref: { taskId: 't-g1', runId: null } }),
        'not-found',
      ),
    ).toContain('has no review record')
    // A string where a review's `{taskId, runId}` belongs names no review either:
    // the pair it declares matches no task in the store.
    expect(
      expectRefused(await stack.service.contextRead('s-g1', { kind: 'review', ref: 't-c2' }), 'not-found'),
    ).toContain('does not resolve')
  })

  test('a not-activated domain holds no record to read, and says so', async () => {
    const { stack } = await chainStack()
    stack.graph({ id: 'g-empty', rootSessionId: 's-empty' })
    stack.sessionLog('s-empty', ['request'])
    expect(
      expectRefused(await stack.service.contextRead('s-empty', { kind: 'task', ref: 't-any' }), 'not-activated'),
    ).toContain('does not exist yet')
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
      const page = expectOk(
        await stack.service.contextRead('s-worker-big', { kind: 'task', ref: 't-big', offset, limit: 256 }),
      )
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

  test('a record whose text carries astral characters pages out whole too', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-worker-astral')
    stack.sessionLog('s-worker-astral', ['request'])
    // An objective with emoji and a musical symbol: four-byte characters, each
    // two UTF-16 code units. The page cursor is a byte offset, so the walk must
    // cross them without dropping or duplicating a byte.
    await stack.seed({
      taskId: 't-astral',
      sessionId: 's-worker-astral',
      runId: 'r-astral',
      objective: `验收 😀${'🎵'.repeat(400)}😀 结束`,
      parentTaskId: 't-root',
      depth: 1,
    })

    const whole = expectOk(await stack.service.contextRead('s-worker-astral', { kind: 'task', ref: 't-astral' }))
    expect(whole.hasMore).toBe(false)
    const record = pageBody(whole.text)

    let offset = 0
    let pages = 0
    const joined: string[] = []
    for (;;) {
      const page = expectOk(
        await stack.service.contextRead('s-worker-astral', { kind: 'task', ref: 't-astral', offset, limit: 256 }),
      )
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
    expect(record).toContain('🎵')
  })

  test('a core contract over the bound is refused as context-too-large, never cut', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-worker-huge')
    stack.sessionLog('s-worker-huge', ['request'])
    await stack.seed({
      taskId: 't-huge',
      sessionId: 's-worker-huge',
      runId: 'r-huge',
      objective: `a huge contract ${'y'.repeat(OVER_BOUND_BYTES)}`,
      parentTaskId: 't-root',
      depth: 1,
    })
    expect(expectRefused(await stack.service.taskRead('s-worker-huge'), 'context-too-large')).toContain('context_read')
    expect(expectRefused(await stack.service.contractProjection('s-worker-huge'), 'context-too-large')).toContain(
      `${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound`,
    )
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
    const second = expectOk(
      await stack.service.contextRead('s-c1', { kind: 'session', ref: 's-c1', offset: first.nextOffset, limit: 1 }),
    )
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
    stack.sessionLog(
      's-flaky',
      Array.from({ length: SESSION_QUERY_READ_WINDOW_MAX + 1 }, (_, seq) => `event ${seq}`),
    )
    const query = (stack.ctx as unknown as { sessionQuery: SessionQuerySeam }).sessionQuery
    const real = query.readEvent.bind(query)
    let calls = 0
    query.readEvent = async (request, signal) => {
      calls += 1
      if (calls > 1) throw new Error('the log stopped answering mid-read')
      return await real(request, signal)
    }
    const result = await stack.service.contextRead('s-root', { kind: 'session', ref: 's-flaky', limit: 100 })
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
    const detail = expectRefused(
      await stack.service.contextRead('s-root', { kind: 'session', ref: 's-stalled' }),
      'unreadable',
    )
    expect(detail).toContain('seq 0')
    expect(detail).toMatch(/advanc/)
  })

  test('an event larger than the bound is refused by name, never cut', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-big-event')
    stack.sessionLog('s-big-event', ['x'.repeat(OVER_BOUND_BYTES)])
    const result = await stack.service.contextRead('s-root', { kind: 'session', ref: 's-big-event', limit: 1 })
    // The refusal names the seq, the size of the event's own text, the fact that
    // an offset addresses whole events, and the one deliberate way past it.
    const detail = expectRefused(result, 'context-too-large')
    expect(detail).toContain('seq 0')
    expect(detail).toContain(String(OVER_BOUND_BYTES))
    expect(detail).toMatch(/whole events/)
    expect(detail).toMatch(/offset 1\b/)
    // It is a refusal, not a page: no partial body of that event is returned.
    expect('text' in result).toBe(false)
    expect(detail).not.toContain('xxxx')
  })

  test('a page ends before an event that does not fit, and the next read refuses at that seq', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-mixed-events')
    stack.sessionLog('s-mixed-events', ['a short event', 'y'.repeat(OVER_BOUND_BYTES)])
    const page = expectOk(await stack.service.contextRead('s-root', { kind: 'session', ref: 's-mixed-events', limit: 2 }))
    expect(page.text).toContain('seq 0 | user/message')
    expect(page.text).not.toContain('yyy')
    // The page ends *before* the oversized event: the next offset is that
    // event's own seq, never seq+1, so the read skips nothing on its own.
    expect(page.hasMore).toBe(true)
    expect(page.nextOffset).toBe(1)
    expect(page.text).toMatch(/seq 1\b.*not shown/)
    expect(page.text).toContain(String(OVER_BOUND_BYTES))
    // A follow-up read at that seq hits the whole-event refusal and names the one
    // offset that moves past it — the caller's choice, not the read's.
    const detail = expectRefused(
      await stack.service.contextRead('s-root', { kind: 'session', ref: 's-mixed-events', offset: 1, limit: 2 }),
      'context-too-large',
    )
    expect(detail).toContain('seq 1')
    expect(detail).toMatch(/offset 2\b/)
  })

  test('every successful page ends with its closing lines, whatever the next event measures', async () => {
    const { stack, chain } = await chainStack()
    // The shape an independent audit measured: a page whose first event nearly
    // fills the bound and then stops before a huge second one. Sizes sweep the
    // byte windows (≈ 396–335 bytes below the bound, and at or past 250 bytes
    // below it) in which the closing lines used to fall outside the bound,
    // leaving the model a page with no cue at all.
    for (const size of [-784, -484, -396, -384, -335, -334, -284, -251, -250, -184, 6].map(
      delta => CONTEXT_OUTPUT_LIMIT_BYTES + delta,
    )) {
      const session = `s-size-${size}`
      stack.member(chain.graph, session)
      stack.sessionLog(session, ['A'.repeat(size), 'B'.repeat(OVER_BOUND_BYTES)])
      const result = await stack.service.contextRead('s-root', { kind: 'session', ref: session, limit: 2 })
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
    const detail = expectRefused(
      await stack.service.contextRead('s-root', { kind: 'session', ref: 's-c1' }),
      'unreadable',
    )
    expect(detail).toContain('membership of session "s-c1"')
    expect(detail).toContain('the graph store is not readable')
  })
})

/**
 * One session event by its `{sessionId, seq}` reference (Q3 closure): the door a
 * session listing opens for an event too large to render inline. The listing's
 * own unit is the whole event, so this read carries the event's *visible text*
 * (`extractSessionEventText`) paged in UTF-8 bytes as JSON — never the raw
 * session JSON, and never a page that splits a character.
 */
describe('one session event by its {sessionId, seq} reference', () => {
  test('the object reference is accepted now, and reads one short event whole', async () => {
    const { stack } = await chainStack()
    // Red first: before this door existed the same call answered the
    // malformed-reference refusal — `not-found` with "the reference given
    // ({"sessionId":"s-c1","seq":0}) is not that shape" — although the tool
    // schema already declared the branch and forwarded it.
    const page = expectOk(
      await stack.service.contextRead('s-c1', { kind: 'session', ref: { sessionId: 's-c1', seq: 0 } }),
    )
    const visible = extractSessionEventText(await loggedEvent(stack, 's-c1', 0))
    const parsed = eventPage(page.text)
    for (const key of ['sessionId', 'seq', 'offset', 'nextOffset', 'hasMore', 'body']) {
      expect(Object.keys(parsed)).toContain(key)
    }
    expect(parsed.sessionId).toBe('s-c1')
    expect(parsed.seq).toBe(0)
    expect(parsed.offset).toBe(0)
    // The body is the event's visible text, not a rendering of the session JSON it lives in.
    expect(parsed.body).toBe(visible)
    expect(parsed.hasMore).toBe(false)
    // Offsets are byte positions in that text: the final page ends at its size.
    expect(parsed.nextOffset).toBe(Buffer.byteLength(visible, 'utf8'))
    // The final page says where the listing continues: the listing pages by
    // event seq, this read by byte, so it names the seq *after* this event.
    expect(parsed.note as string).toContain('offset = 1')
    expect(parsed.note as string).toContain('s-c1')
    // The struct's continuation is the page's own: either one continues from the same place.
    expect(page.hasMore).toBe(parsed.hasMore)
    expect(page.nextOffset).toBe(parsed.nextOffset)
    expect(page.source).toContain('s-c1')
    expect(page.source).toContain('seq 0')
    expect(page.source).toContain(String(Buffer.byteLength(visible, 'utf8')))
  })

  // The floor walk is deliberately thousands of pages (one character at a time
  // over a body past the bound), so it gets room beyond the default per-test
  // budget.
  test(
    'a long body of Chinese text and escaped characters walks out page by page, character for character',
    { timeout: 60_000 },
    async () => {
      const { stack, chain } = await chainStack()
      stack.member(chain.graph, 's-long')
      // Chinese (3-byte) characters plus every class JSON widens: a quote, a
      // backslash, a newline and a control character. The bound is on the JSON the
      // model receives rather than on the raw fragment, so a body whose escapes
      // multiply its size still has to walk out whole.
      const seeded = `正文开始 ${'汉'.repeat(2_000)} 引号:" 反斜杠:\\ 换行:\n 控制:\u0007 ${'x'.repeat(CONTEXT_OUTPUT_LIMIT_BYTES)} 正文结束`
      stack.sessionLog('s-long', [seeded])
      const visible = extractSessionEventText(await loggedEvent(stack, 's-long', 0))
      expect(Buffer.byteLength(visible, 'utf8')).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT_BYTES)
      for (const character of ['汉', '"', '\\', '\n', '\u0007']) expect(visible).toContain(character)

      const wide = await walkEvent(stack, 's-root', 's-long', 0, 4_096)
      expect(wide.pages).toBeGreaterThan(1)
      expect(wide.text).toBe(visible)
      // The same walk at the clamp floor: four bytes a page, one character at a
      // time, still whole, still strictly advancing.
      const narrow = await walkEvent(stack, 's-root', 's-long', 0, 4)
      expect(narrow.pages).toBeGreaterThan(1_000)
      expect(narrow.text).toBe(visible)
    },
  )

  test('a body of astral characters walks out page by page, character for character', { timeout: 60_000 }, async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-astral')
    // Emoji and a musical symbol: one character in *two* UTF-16 code units, four
    // UTF-8 bytes. A window that counted characters but cut code units would start
    // every page after one of these a unit early — a lone surrogate in the page,
    // and a cursor inside a character, so the rest of the body could never be read.
    const seeded = `开始😀${'😀'.repeat(300)}中${'🎵'.repeat(80)}结束`
    stack.sessionLog('s-astral', [seeded])
    const visible = extractSessionEventText(await loggedEvent(stack, 's-astral', 0))
    expect(visible).toBe(seeded)

    // Four bytes a page: exactly one astral character at a time.
    const narrow = await walkEvent(stack, 's-root', 's-astral', 0, 4)
    expect(narrow.pages).toBeGreaterThan(300)
    expect(narrow.text).toBe(visible)
    // And a page wider than one character must still cut on a character boundary.
    const wide = await walkEvent(stack, 's-root', 's-astral', 0, 33)
    expect(wide.pages).toBeGreaterThan(1)
    expect(wide.text).toBe(visible)
  })

  test('an escape-heavy body never exceeds the page bound, and every page still advances', async () => {
    const { stack, chain } = await chainStack()
    // One body whose every character escapes to two bytes, one whose every
    // character escapes to six: a raw-byte page of either would blow the bound
    // after escaping, so the page is sized against the JSON, not the fragment.
    for (const [session, body] of [
      ['s-quotes', '"'.repeat(OVER_BOUND_BYTES)],
      ['s-controls', '\u0007'.repeat(OVER_BOUND_BYTES)],
    ] as const) {
      stack.member(chain.graph, session)
      stack.sessionLog(session, [body])
      const visible = extractSessionEventText(await loggedEvent(stack, session, 0))
      const walk = await walkEvent(stack, 's-root', session, 0)
      expect(walk.pages).toBeGreaterThan(1)
      expect(walk.text).toBe(visible)
    }
  })

  test('the limit clamps into 4..the bound', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-clamped')
    stack.sessionLog('s-clamped', ['l'.repeat(OVER_BOUND_BYTES)])
    const counter = trackEventReads(stack)
    // The clamp floor is 4 bytes: a page always carries at least one character,
    // so an offset handed back never stalls on the same byte again.
    const floor = eventPage(
      expectOk(
        await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-clamped', seq: 0 }, limit: 1 }),
      ).text,
    )
    expect(Buffer.byteLength(floor.body, 'utf8')).toBe(4)
    expect(floor.hasMore).toBe(true)
    // The ceiling is the output bound, and what fits in it is the page *JSON*,
    // so a huge limit still yields a body smaller than the bound — and the page
    // says there is more, so the body below is a page, not the whole event.
    const capped = expectOk(
      await stack.service.contextRead('s-root', {
        kind: 'session',
        ref: { sessionId: 's-clamped', seq: 0 },
        limit: 999_999,
      }),
    )
    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
    expect(eventPage(capped.text).hasMore).toBe(true)
    expect(Buffer.byteLength(eventPage(capped.text).body, 'utf8')).toBeLessThan(CONTEXT_OUTPUT_LIMIT_BYTES)
    // A limit below the floor is raised to it: still a page, never an empty one.
    const zero = eventPage(
      expectOk(
        await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-clamped', seq: 0 }, limit: 0 }),
      ).text,
    )
    expect(Buffer.byteLength(zero.body, 'utf8')).toBe(4)
    expect(counter.reads).toBe(3)
  })

  test('the listing hands a too-large event back as the exact reference that reads it', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-hand')
    stack.sessionLog('s-hand', ['a short event', 'y'.repeat(OVER_BOUND_BYTES)])
    // A page that stops before the event names it, its size, and the reference
    // that reads its text — never "skip it to get its body".
    const page = expectOk(await stack.service.contextRead('s-root', { kind: 'session', ref: 's-hand', limit: 2 }))
    expect(page.text).toContain('ref:{"sessionId":"s-hand","seq":1}')
    expect(page.text).toContain(String(OVER_BOUND_BYTES))
    // The refusal when the event is the page's first names the same reference,
    // and moving past the event stays the caller's explicit choice.
    const refused = expectRefused(
      await stack.service.contextRead('s-root', { kind: 'session', ref: 's-hand', offset: 1, limit: 2 }),
      'context-too-large',
    )
    expect(refused).toContain('ref:{"sessionId":"s-hand","seq":1}')
    expect(refused).toMatch(/cannot render/)
    expect(refused).toContain('offset 2')
    // The handed-back reference really is the door to that event's text: walked
    // to its end, it restores the whole event.
    const walk = await walkEvent(stack, 's-root', 's-hand', 1)
    expect(walk.text).toBe('y'.repeat(OVER_BOUND_BYTES))
  })
})

/**
 * The refusals of a session-event read: the session is checked against the
 * caller's graph before DSH is asked, and a reference the log cannot answer —
 * an absent seq, an offset on no character boundary, an unreadable log — comes
 * back as a named refusal that carries no body.
 */
describe('the refusals of a session event read', () => {
  test('a session of another graph, and a membership view that fails, are refused before the log is touched', async () => {
    const { stack, chain } = await chainStack()
    const other = await secondGraph(stack)
    const counter = trackEventReads(stack)
    expect(
      expectRefused(
        await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: other.rootSession, seq: 0 } }),
        'cross-graph',
      ),
    ).toContain('not a published member')
    expect(counter.reads).toBe(0)
    // An unverifiable membership is a named failure, never a pass: the event
    // door checks the graph store exactly as the listing does.
    stack.breakGraphView(new Error('the graph store is not readable'), chain.graph)
    const detail = expectRefused(
      await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-c1', seq: 0 } }),
      'unreadable',
    )
    expect(detail).toContain('membership of session "s-c1"')
    expect(detail).toContain('the graph store is not readable')
    expect(counter.reads).toBe(0)
  })

  test('an event the log does not hold is stale, and a log that stops answering is unreadable with no text', async () => {
    const { stack } = await chainStack()
    // s-c1's log holds seq 0 and 1 and nothing else.
    expect(
      expectRefused(
        await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-c1', seq: 5 } }),
        'stale-reference',
      ),
    ).toContain('seq 5')
    const query = (stack.ctx as unknown as { sessionQuery: SessionQuerySeam }).sessionQuery
    query.readEvent = async () => {
      throw new Error('the log stopped answering')
    }
    const result = await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-c1', seq: 0 } })
    expect(expectRefused(result, 'unreadable')).toContain('the log stopped answering')
    // A failed read is a refusal, not a page: no partial body, no JSON wrapper.
    expect('text' in result).toBe(false)
    expect(JSON.stringify(result)).not.toContain('child one')
  })

  test('an answer that names another event is stale, never rendered as this one', async () => {
    const { stack } = await chainStack()
    const query = (stack.ctx as unknown as { sessionQuery: SessionQuerySeam }).sessionQuery
    const real = query.readEvent.bind(query)
    query.readEvent = async (request, signal) => {
      const window = await real(request, signal)
      // The log's seq-1 event where seq 0 was asked for: a source that answers a
      // different event must not have that event's text rendered as seq 0's.
      return request.seq === 0 ? { ...window, target: (await real({ ...request, seq: 1 }, signal)).target } : window
    }
    const detail = expectRefused(
      await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-c1', seq: 0 } }),
      'stale-reference',
    )
    expect(detail).toContain('seq 1')
    expect(detail).toContain('seq 0')
  })

  test('an offset inside a character, at the end of the text and far past it is stale, never silently realigned', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-bytes')
    // A body that starts with a three-byte character: bytes 1 and 2 are inside it.
    stack.sessionLog('s-bytes', [`中${'x'.repeat(32)}`])
    const visible = extractSessionEventText(await loggedEvent(stack, 's-bytes', 0))
    const total = Buffer.byteLength(visible, 'utf8')
    for (const offset of [1, 2, total, 999_999]) {
      expect(
        expectRefused(
          await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-bytes', seq: 0 }, offset }),
          'stale-reference',
        ),
      ).toContain(String(offset))
    }
    // Byte 3 is the boundary after that character: a page from there is the rest of the text.
    const tail = eventPage(
      expectOk(
        await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-bytes', seq: 0 }, offset: 3 }),
      ).text,
    )
    expect(tail.offset).toBe(3)
    expect(tail.body).toBe(visible.slice(1))
  })

  test('an event with no visible text has exactly one page, and only at offset 0', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-empty-event')
    // An event whose extractable text is empty: there is nothing to page, so the
    // one page that exists is offset 0's, and any later byte is past its end.
    stack.sessionLog('s-empty-event', [''])
    const result = expectOk(
      await stack.service.contextRead('s-root', { kind: 'session', ref: { sessionId: 's-empty-event', seq: 0 } }),
    )
    const parsed = eventPage(result.text)
    expect(parsed.body).toBe('')
    expect(parsed.hasMore).toBe(false)
    expect(parsed.nextOffset).toBe(0)
    expect(result.hasMore).toBe(false)
    expect(result.nextOffset).toBe(0)
    expect(parsed.note as string).toContain('offset = 1')
    expect(
      expectRefused(
        await stack.service.contextRead('s-root', {
          kind: 'session',
          ref: { sessionId: 's-empty-event', seq: 0 },
          offset: 5,
        }),
        'stale-reference',
      ),
    ).toContain('5')
  })
})

describe('task_status pagination', () => {
  test('entries sort by task id, offset and limit page them, and the tail says there is no more', async () => {
    const { stack } = await chainStack()
    const first = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', limit: 2 }))
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(2)
    const ids = [...first.text.matchAll(/^- (t-[a-z0-9]+) /gm)].map(match => match[1])
    expect(ids).toEqual(['t-c1', 't-c2'])
    const second = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', offset: 2, limit: 2 }))
    const secondIds = [...second.text.matchAll(/^- (t-[a-z0-9]+) /gm)].map(match => match[1])
    expect(secondIds).toEqual(['t-g1', 't-replay'])
    expect(second.hasMore).toBe(true)
    expect(second.nextOffset).toBe(4)
    const last = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', offset: 4, limit: 2 }))
    expect([...last.text.matchAll(/^- (t-[a-z0-9]+) /gm)].map(match => match[1])).toEqual(['t-root'])
    expect(last.hasMore).toBe(false)
    expect(last.text).toContain('this is the end of the scope')
    // An offset past the end is an empty page, not a refusal.
    const past = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', offset: 50 }))
    expect(past.hasMore).toBe(false)
    expect(past.text).toContain('this is the end of the scope')
  })

  test('a first entry over the bound is refused by name, with both ways forward', async () => {
    const { stack, chain } = await chainStack()
    const { taskId, index, lineBytes } = await seedOversizedStatusEntry(stack, chain)
    // The listing starts at the entry that cannot be shown: a page of zero
    // entries at this offset would report the same offset again, so it is a
    // refusal that names the entry and both ways past it.
    const result = await stack.service.taskStatus('s-root', { scope: 'graph', offset: index, limit: 1 })
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

  test("a page that meets an over-bound entry stops before it, at that entry's own index", async () => {
    const { stack, chain } = await chainStack()
    const { taskId, index } = await seedOversizedStatusEntry(stack, chain)
    const page = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', offset: 0, limit: 100 }))
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
    const clamped = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', limit: 1_000 }))
    expect(clamped.text).toContain('limit 100 (requested offset 0, limit 1000: both are clamped into their ranges)')
    const zero = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', limit: 0 }))
    expect(zero.text).toContain('limit 1')
    const negative = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', offset: -5, limit: 2 }))
    expect(negative.text).toContain('offset 0')
    const inRange = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph', limit: 3 }))
    expect(inRange.text).toContain('scope: graph · offset 0 · limit 3')
    expect(inRange.text).not.toContain('clamped')
  })

  test("the related scope from a reviewer covers the delegated task's relations", async () => {
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
    const text = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph' })).text
    expect(text).toContain('- obligations: 1 recorded')
    expect(text).not.toContain('obligation coverage')
  })

  test('a mounted env builder with no discoverable templates still reports the count', async () => {
    const { stack } = await chainStack()
    await stack.oblige({ obligationId: 'o-1', taskId: 't-c2', sessionId: 's-c2' })
    stack.mountEnvBuilder()
    const text = expectOk(await stack.service.taskStatus('s-root', { scope: 'graph' })).text
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

/** The Task method comes from its explicit bound Skill, never synthesized by the read. */
describe('the bound guidance in the contract projection', () => {
  test('loads the complete relevant method for a coordinating child and an atomic leaf', async () => {
    const stack = new FixtureStack()
    await seedChain(stack)
    const child = expectOk(await stack.service.contractProjection('s-c1')).text
    const leaf = expectOk(await stack.service.contractProjection('s-g1')).text
    expect(child).toContain('## Guidance loaded for this run')
    expect(child).toContain('### Skill bridge-construction')
    expect(child).toContain('Delegate the deck as a separate result')
    expect(leaf).toContain('### Skill deck-construction')
    expect(leaf).toContain('Check dimensions and fastening')
    expect(leaf).not.toContain('Delegate the deck')
    stack.runtimeDecomposition = false
    expect(expectOk(await stack.service.contractProjection('s-c1')).text).toBe(child)
  })

  test('refuses an executing Task without bound guidance and a damaged snapshot', async () => {
    const stack = new FixtureStack()
    await seedChain(stack, 's-root', true)
    expect(expectRefused(await stack.service.contractProjection('s-c1'), 'unreadable')).toContain('content-mismatch')
    stack.member('g-s-root', 's-unguided')
    stack.sessionLog('s-unguided', ['build a separate deck'])
    await stack.seed({ taskId: 't-unguided', sessionId: 's-unguided', runId: 'r-unguided',
      objective: 'build a separate deck', parentTaskId: 't-root', depth: 1 })
    expect(expectRefused(await stack.service.contractProjection('s-unguided'), 'unreadable')).toContain('no bound guidance Skill')
  })

  test("the unconditional worker rules are the agent runtime's policy section, not this projection", async () => {
    const stack = new FixtureStack()
    await seedChain(stack)
    const text = expectOk(await stack.service.contractProjection('s-c1')).text
    expect(text).not.toContain('Going idle is not a submission')
    expect(text).not.toContain('`task_verify` is only a self-check')
    expect(text).not.toContain('never declare completion yourself — an external verifier')
  })
})
