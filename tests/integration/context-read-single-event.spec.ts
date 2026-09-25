import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractSessionEventText } from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import { CONTEXT_OUTPUT_LIMIT_BYTES } from '../../context/src/index.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

/**
 * Q3-1/Q3-2 (2026-09-25 closure), at the tool door the model actually calls: one
 * session **event** read by its own reference, `ref: {sessionId, seq}`, through
 * the real `context_read` adapter, the real read core, the real store and the
 * real session log.
 *
 * The property this file pins is the one the session listing alone cannot give:
 * an event whose visible text is larger than the output bound is never cut and
 * never skipped. The listing names the event's own `{sessionId, seq}` reference
 * instead of pushing `nextOffset` past it, and that reference pages the event's
 * visible text — `extractSessionEventText`, the same text the listing renders —
 * in UTF-8 bytes. Concatenating the pages' `body` by `nextOffset` has to restore
 * the whole text character-for-character, every rendered page has to stay inside
 * the bound after JSON escaping, and every way the read can be asked for
 * something it cannot answer has to come back as a named refusal with no body
 * and, where the answer is decidable without the log, without asking the log.
 *
 * The fixture's session plane is the seam this file patches: it counts the
 * reads, and for two cases it hands back exactly what DSH hands back — the
 * coded `SESSION_QUERY_EVENT_NOT_FOUND` for a seq the log does not hold, and a
 * plain failure for a source that stopped answering.
 */

/** What one tool call answered. */
interface ToolAnswer {
  readonly isError: boolean
  readonly text: string
}

/** One successful single-event page, as the tool rendered it. */
interface SingleEventPage {
  readonly sessionId: string
  readonly seq: number
  readonly offset: number
  readonly nextOffset: number
  readonly hasMore: boolean
  readonly body: string
  readonly note?: string
}

/** The six keys every successful page carries; the `note` rides the last one. */
const PAGE_KEYS = ['sessionId', 'seq', 'offset', 'nextOffset', 'hasMore', 'body'] as const

/** One `{sessionId, seq}` reference, the shape a session listing hands back for an oversized event. */
interface EventReference {
  readonly sessionId: string
  readonly seq: number
}

const stacks: AssemblyStack[] = []

async function boot(options: Parameters<typeof startAssemblyStack>[0] = {}): Promise<AssemblyStack> {
  const stack = await startAssemblyStack(options)
  stacks.push(stack)
  return stack
}

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await Promise.race([
      stack.dispose({ remove: stack.dir.includes('singularity-assembly-') }),
      new Promise(resolve => {
        setTimeout(resolve, 2_000).unref()
      }),
    ])
  }
  vi.unstubAllEnvs()
})

/** UTF-8 byte length, the unit every page in this file is measured in. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The oversized event's body (Q3-1): past the output bound, built from the three
 * things a byte-metered page has to survive — Chinese characters three bytes
 * wide, characters JSON escaping widens (`"`, `\`, and a `\u0007` control
 * character), and newlines the listing renders line by line. The last block is a
 * bound's worth of three-byte characters on its own, so the visible text is
 * several KB past the bound however the earlier blocks are sized.
 */
function giantBody(): string {
  return [
    '这一页放不下的事件正文，含中文与需要 JSON 转义的字符。',
    '"quoted" text, a backslash \\ and a bell \u0007 on one line',
    '中'.repeat(3_000),
    '\u0007'.repeat(4_000),
    '文'.repeat(Math.ceil(CONTEXT_OUTPUT_LIMIT_BYTES / 3)),
    'giant-tail-marker：正文结束。',
  ].join('\n')
}

/**
 * The exact `{sessionId, seq}` reference one page names, parsed out of the text
 * the model was handed: the page's own words are the only place it comes from,
 * which is what makes it a reference the caller can really use next.
 */
function referenceIn(text: string): EventReference {
  const match = /\{\s*"sessionId"\s*:\s*"([^"]+)"\s*,\s*"seq"\s*:\s*(\d+)\s*\}/.exec(text)
  if (match === null) throw new Error(`the answer names no {sessionId, seq} reference:\n${text}`)
  return { sessionId: match[1] as string, seq: Number(match[2]) }
}

/**
 * Read one `{sessionId, seq}` reference page by page through the real tool — the
 * page order is the pages' own `nextOffset` — and hand back every page it
 * rendered together with the whole JSON text of each.
 *
 * What a caller may assume of every successful page is asserted here, once: it
 * is valid JSON, it carries the six keys, its rendered text is inside the bound
 * (escapes included), it answers for the offset that was asked, and while it
 * says `hasMore` it advances strictly. The cases that follow assert what the
 * pages *add up to*.
 */
async function readEventPages(
  stack: AssemblyStack,
  caller: string,
  ref: EventReference,
  limit: number,
): Promise<{ readonly pages: SingleEventPage[]; readonly texts: readonly string[] }> {
  const pages: SingleEventPage[] = []
  const texts: string[] = []
  let offset = 0
  for (let guard = 0; guard < 2_000; guard += 1) {
    const answer = await stack.call(caller, 'context_read', { kind: 'session', ref, offset, limit })
    expect(answer.isError, answer.text).toBe(false)
    const page = JSON.parse(answer.text) as SingleEventPage
    const where = `page at offset ${offset} (limit ${limit})`
    for (const key of PAGE_KEYS) expect(Object.hasOwn(page, key), `${where}: ${answer.text}`).toBe(true)
    expect(page.sessionId, where).toBe(ref.sessionId)
    expect(page.seq, where).toBe(ref.seq)
    expect(page.offset, where).toBe(offset)
    expect(utf8Bytes(answer.text), where).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
    pages.push(page)
    texts.push(answer.text)
    if (!page.hasMore) return { pages, texts }
    expect(page.nextOffset, where).toBeGreaterThan(offset)
    offset = page.nextOffset
  }
  throw new Error(`the ${limit}-byte walk never reached the end of seq ${ref.seq}`)
}

/** The failure a refusal names, and the body fragment the answer must not carry. */
function refusal(answer: ToolAnswer, name: string, where: string): void {
  expect(answer.text, where).toContain(`context_read ${name}`)
}

/**
 * Replace the session plane's exact read with `body` (or with nothing, for a
 * plain count), counting every call: a read a case says must not happen is then
 * a number rather than a guess, and the fixture's own read is handed back
 * through `next` so a wrapper still answers like DSH.
 */
function patchReadEvent(
  stack: AssemblyStack,
  body?: (
    request: { readonly sessionId: string; readonly seq: number },
    next: (request: { readonly sessionId: string; readonly seq: number }, signal?: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>,
): { readonly count: number; restore(): void } {
  const query = stack.ctx.get('sessionQuery') as unknown as {
    readEvent: (request: { readonly sessionId: string; readonly seq: number }, signal?: AbortSignal) => Promise<unknown>
  }
  const original = query.readEvent.bind(query)
  let count = 0
  query.readEvent = (async (request: { readonly sessionId: string; readonly seq: number }, signal?: AbortSignal) => {
    count += 1
    return body === undefined ? await original(request, signal) : await body(request, original, signal)
  }) as typeof query.readEvent
  return {
    get count(): number {
      return count
    },
    restore(): void {
      query.readEvent = original
    },
  }
}

describe('one session event, by its own reference (Q3-1)', () => {
  const SESSION = 's-root'
  const GIANT_SEQ = 1
  const SHORT = 'a short first event'
  const TAIL = 'the tail event after the giant one'

  it('is named by the listing, pages by bytes to the whole body, and returns the listing at the next event', async () => {
    const stack = await boot({ worker: async () => {} })
    const giant = giantBody()
    expect(utf8Bytes(giant)).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT_BYTES)
    await stack.seedLog(SESSION, [SHORT, giant, TAIL])

    // The event's visible text is the seeded string: compare against both, and
    // against each other, before any page is read.
    const event = (await stack.log(SESSION)).find(item => Number(item.seq) === GIANT_SEQ)
    expect(event).toBeDefined()
    const visible = extractSessionEventText(event!)
    expect(visible).toBe(giant)

    // The listing page whose first event is the giant one: nothing of the body
    // is shown, and the page names the exact reference to read it with.
    const first = await stack.call(SESSION, 'context_read', {
      kind: 'session',
      ref: SESSION,
      offset: GIANT_SEQ,
      limit: 1,
    })
    expect(first.text).toContain('context_read context-too-large')
    expect(first.text).toContain(`{"sessionId":"${SESSION}","seq":${GIANT_SEQ}}`)
    expect(first.text).not.toContain(giant)
    expect(first.text).not.toContain(giant.slice(0, 120))
    expect(first.text).not.toContain(giant.slice(-120))
    const reference = referenceIn(first.text)
    expect(reference).toEqual({ sessionId: SESSION, seq: GIANT_SEQ })

    // The reference the page named is real: it pages that event's whole visible
    // text, at the bound the caller asked for.
    const large = await readEventPages(stack, SESSION, reference, 4_096)
    expect(large.pages.map(page => page.body).join('')).toBe(giant)
    expect(large.pages.map(page => page.body).join('')).toBe(visible)
    for (const page of large.pages) {
      expect(page.offset + utf8Bytes(page.body), `page at offset ${page.offset}`).toBe(page.nextOffset)
    }
    const last = large.pages[large.pages.length - 1] as SingleEventPage
    expect(last.hasMore).toBe(false)
    expect(last.nextOffset).toBe(utf8Bytes(giant))
    expect(String(last.note), last.note).toMatch(/offset\s*=?\s*2\b/)

    // A page size far below the bound takes many more pages and restores the
    // same text, escapes and all — the page split is a cursor, not a cut.
    const small = await readEventPages(stack, SESSION, reference, 64)
    expect(small.pages.length).toBeGreaterThan(large.pages.length)
    expect(small.pages.map(page => page.body).join('')).toBe(giant)
    for (const answer of small.texts) expect(utf8Bytes(answer)).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)

    // The listing continues where the event's own page said it would.
    const rest = await stack.call(SESSION, 'context_read', {
      kind: 'session',
      ref: SESSION,
      offset: GIANT_SEQ + 1,
      limit: 2,
    })
    expect(rest.isError).toBe(false)
    expect(rest.text).toContain(TAIL)
    expect(rest.text).not.toContain(giant)

    // A listing page that *stops before* the giant event names the reference in
    // its own text as well, so the way into the body is on the page that first
    // meets it.
    const stopped = await stack.call(SESSION, 'context_read', { kind: 'session', ref: SESSION, offset: 0, limit: 2 })
    expect(stopped.isError).toBe(false)
    expect(stopped.text).toContain(SHORT)
    expect(stopped.text).toContain(`{"sessionId":"${SESSION}","seq":${GIANT_SEQ}}`)
    expect(stopped.text).not.toContain(giant)
    expect(stopped.text).not.toContain(giant.slice(0, 120))
    expect(referenceIn(stopped.text)).toEqual({ sessionId: SESSION, seq: GIANT_SEQ })
  })
})

describe('what a single-event read refuses, and what it never asks (Q3-2)', () => {
  const ROOT = 's-root'
  const MEMBER = 's-worker'
  const FOREIGN = 's-other-worker'
  const FOREIGN_BODY = '他图会话的私有日志 foreign-body-marker'
  /** A body whose first four bytes end on a character boundary: a 3-byte character then one ASCII byte. */
  const MEMBER_BODY = `中a${'文'.repeat(40)}！尾`

  /** Two graphs in one checkout: the caller's graph publishes `s-worker`, the other owns `s-other-worker`. */
  async function twoGraphs(): Promise<AssemblyStack> {
    const stack = await boot({
      graphs: [
        { id: 'g1', rootSessionId: ROOT, members: [MEMBER] },
        { id: 'g2', rootSessionId: 's-other', members: [FOREIGN] },
      ],
      worker: async () => {},
    })
    await stack.seedLog(MEMBER, [MEMBER_BODY])
    await stack.seedLog(FOREIGN, [FOREIGN_BODY])
    return stack
  }

  it("refuses another graph's event by name, and asks the log nothing for a reference that names no event", async () => {
    const stack = await twoGraphs()

    // 1. A session of another graph: known `{sessionId, seq}`, still refused
    //    before DSH is asked anything — and none of its body in the answer.
    const reads = patchReadEvent(stack)
    const foreign = await stack.call(ROOT, 'context_read', { kind: 'session', ref: { sessionId: FOREIGN, seq: 0 } })
    expect(reads.count).toBe(0)
    refusal(foreign, 'cross-graph', 'a foreign session')
    expect(foreign.text).toContain(FOREIGN)
    expect(foreign.text).not.toContain(FOREIGN_BODY)
    expect(foreign.text).not.toContain('foreign-body-marker')

    // 2. A reference that names no event: the session alone, and a sessionId that
    //    is not an id. The contract's refusal for both is `not-found`, and
    //    neither may read. The sessionId-only reference reaches the read core
    //    through the tool door; the type-wrong sessionId is refused one door
    //    earlier — the tool's own schema declares `sessionId: string`, so the
    //    registry answers invalid arguments — and the service door behind it is
    //    where the read core's own `not-found` is visible.
    reads.restore()
    const noSeq = patchReadEvent(stack)
    const missing = await stack.call(ROOT, 'context_read', { kind: 'session', ref: { sessionId: MEMBER } })
    expect(noSeq.count).toBe(0)
    refusal(missing, 'not-found', 'a reference with no seq')
    expect(missing.text).not.toContain(MEMBER_BODY)
    noSeq.restore()

    const notAnId = patchReadEvent(stack)
    const wrongId = await stack.call(ROOT, 'context_read', { kind: 'session', ref: { sessionId: 42, seq: 0 } })
    expect(notAnId.count).toBe(0)
    expect(wrongId.isError, wrongId.text).toBe(true)
    expect(wrongId.text).toMatch(/invalid arguments/)
    expect(wrongId.text).toContain('"ref"')
    expect(wrongId.text).not.toContain(MEMBER_BODY)
    notAnId.restore()

    // The service door behind the tool, where no schema stands in front of the
    // read core: every one of those shapes is `not-found` there — the same rule
    // the tool door spells as invalid arguments — and none of them reads.
    const service = stack.ctx.get('singularityContext') as unknown as {
      contextRead(
        sessionId: string,
        query: unknown,
      ): Promise<{ readonly ok: boolean; readonly refusal?: string; readonly detail?: string }>
    }
    const serviceReads = patchReadEvent(stack)
    const atService = await service.contextRead(ROOT, { kind: 'session', ref: { sessionId: 42, seq: 0 } })
    expect(serviceReads.count).toBe(0)
    expect(atService.ok).toBe(false)
    expect(atService.refusal).toBe('not-found')
    expect(String(atService.detail)).not.toContain(MEMBER_BODY)
    serviceReads.restore()

    // 3. Numbers a page cannot be taken at: a negative seq and a fractional seq
    //    are refusals, and a negative or fractional byte offset is a stale
    //    reference — none of them reads the log.
    for (const [label, ref] of [
      ['a negative seq', { sessionId: MEMBER, seq: -1 }],
      ['a fractional seq', { sessionId: MEMBER, seq: 1.5 }],
    ] as const) {
      const counted = patchReadEvent(stack)
      const answer = await stack.call(ROOT, 'context_read', { kind: 'session', ref })
      expect(counted.count, label).toBe(0)
      if (answer.isError) {
        // The tool schema declares `seq` an integer, so an out-of-type seq is
        // refused at the door, before the read core sees it.
        expect(answer.text, label).toMatch(/invalid arguments/)
      } else {
        refusal(answer, 'not-found', label)
      }
      expect(answer.text, label).not.toContain(MEMBER_BODY)
      counted.restore()

      const atCore = patchReadEvent(stack)
      const projected = await service.contextRead(ROOT, { kind: 'session', ref })
      expect(atCore.count, label).toBe(0)
      expect(projected.ok, label).toBe(false)
      expect(projected.refusal, label).toBe('not-found')
      expect(String(projected.detail), label).not.toContain(MEMBER_BODY)
      atCore.restore()
    }

    for (const [label, offset] of [
      ['a negative offset', -1],
      ['a fractional offset', 2.5],
    ] as const) {
      const counted = patchReadEvent(stack)
      const answer = await stack.call(ROOT, 'context_read', {
        kind: 'session',
        ref: { sessionId: MEMBER, seq: 0 },
        offset,
      })
      expect(counted.count, label).toBe(0)
      refusal(answer, 'stale-reference', label)
      expect(answer.text, label).not.toContain(MEMBER_BODY)
      counted.restore()
    }

    const zeroLimit = patchReadEvent(stack)
    const noPage = await stack.call(ROOT, 'context_read', {
      kind: 'session',
      ref: { sessionId: MEMBER, seq: 0 },
      limit: 0,
    })
    expect(zeroLimit.count).toBe(0)
    refusal(noPage, 'not-found', 'a zero limit')
    expect(noPage.text).not.toContain(MEMBER_BODY)
    zeroLimit.restore()
  })

  it('refuses a seq the log does not hold, a mid-character and an out-of-range offset, and a source that stopped answering', async () => {
    const stack = await twoGraphs()

    // 4. A seq the log does not hold: the session plane answers with DSH's own
    //    coded "no event" error, which is a stale reference, not a failure of the
    //    source.
    const beyond = await stack.call(ROOT, 'context_read', { kind: 'session', ref: { sessionId: MEMBER, seq: 999 } })
    refusal(beyond, 'stale-reference', 'a seq the log does not hold')
    expect(beyond.text).toContain('999')
    expect(beyond.text).not.toContain(MEMBER_BODY)
    expect(beyond.text).not.toContain('文'.repeat(3))

    // 5. Byte offsets a body cannot be entered at, computed from the real body:
    //    one byte into a 3-byte character, exactly at its end, and far past it.
    //    The first four bytes of the body are a whole character boundary, which
    //    is what makes the 4-byte page below a valid page.
    const bodyBytes = utf8Bytes(MEMBER_BODY)
    expect(utf8Bytes(MEMBER_BODY.slice(0, 2))).toBe(4)
    for (const [label, offset] of [
      ['mid-character', 1],
      ['at the end of the body', bodyBytes],
      ['past the end of the body', 999_999],
    ] as const) {
      const answer = await stack.call(ROOT, 'context_read', {
        kind: 'session',
        ref: { sessionId: MEMBER, seq: 0 },
        offset,
      })
      refusal(answer, 'stale-reference', label)
      expect(answer.text, label).not.toContain(MEMBER_BODY)
      expect(answer.text, label).not.toContain('文'.repeat(3))
      expect(answer.text, label).not.toContain(MEMBER_BODY.slice(0, 1))
    }

    // 6. A source that fails: a plain failure, not a coded one, is `unreadable`
    //    — the answer says the read failed and carries no part of the body.
    const broken = patchReadEvent(stack, async () => {
      throw new Error('the session log backend stopped answering')
    })
    const failed = await stack.call(ROOT, 'context_read', { kind: 'session', ref: { sessionId: MEMBER, seq: 0 } })
    refusal(failed, 'unreadable', 'a source failure')
    expect(failed.text).not.toContain(MEMBER_BODY)
    expect(failed.text).not.toContain('文'.repeat(3))
    broken.restore()
  })

  it("reads a member session in a 4-byte page, the clamp's floor, and pages the whole body after it", async () => {
    const stack = await twoGraphs()

    // 7. A byte limit of 4 is the clamp floor: the page carries the four bytes
    //    that end on a character boundary (one 3-byte character plus one byte),
    //    advances by exactly those bytes, and the walk from there restores the
    //    whole body.
    const page = await stack.call(ROOT, 'context_read', {
      kind: 'session',
      ref: { sessionId: MEMBER, seq: 0 },
      limit: 4,
    })
    expect(page.isError, page.text).toBe(false)
    const first = JSON.parse(page.text) as SingleEventPage
    expect(first.body).toBe('中a')
    expect(utf8Bytes(first.body)).toBe(4)
    expect(first.offset).toBe(0)
    expect(first.nextOffset).toBe(4)
    expect(first.hasMore).toBe(true)

    const walk = await readEventPages(stack, ROOT, { sessionId: MEMBER, seq: 0 }, 4)
    expect(walk.pages.map(item => item.body).join('')).toBe(MEMBER_BODY)
    const last = walk.pages[walk.pages.length - 1] as SingleEventPage
    expect(last.hasMore).toBe(false)
    expect(String(last.note), last.note).toMatch(/offset\s*=?\s*1\b/)
  })

  it('refuses an unreadable membership view by name, and still asks the log nothing', async () => {
    const stack = await twoGraphs()
    // The graph registry's own view failing: which sessions a graph publishes
    // cannot be read, and a membership that cannot be read is not a pass — the
    // read is refused as `unreadable` rather than answered from the log.
    const registry = stack.ctx.get('graphs') as unknown as { view: (id: string) => Promise<unknown> }
    const original = registry.view.bind(registry)
    registry.view = async () => {
      throw new Error('the graph store stopped answering')
    }
    try {
      const reads = patchReadEvent(stack)
      const answer = await stack.call(ROOT, 'context_read', { kind: 'session', ref: { sessionId: MEMBER, seq: 0 } })
      expect(reads.count).toBe(0)
      refusal(answer, 'unreadable', 'an unreadable membership view')
      expect(answer.text).toContain('membership')
      expect(answer.text).not.toContain(MEMBER_BODY)
      reads.restore()
    } finally {
      registry.view = original
    }
  })
})
