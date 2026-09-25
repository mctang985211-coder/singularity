/**
 * The bounds and the vocabulary themselves (A2 §D/§6/§7): one output bound —
 * this deployment's own model-facing inline cap — one closed set of refusal
 * names, and the rule that no read, reference list included, can put more than
 * the bound in front of a model.
 */

import { describe, expect, test } from 'vitest'
import { CONTEXT_OUTPUT_LIMIT_BYTES, NAMED_REFUSALS, sliceUtf8, utf8Bytes } from '../../src/index.ts'
import { FixtureStack, seedChain, type Chain } from '../support/stack.ts'
import { expectOk, expectRefused } from '../support/stack.ts'

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

describe('the output bound', () => {
  test('is one constant, and every read stays inside it', async () => {
    const { stack } = await chainStack()
    // The one literal pin of the bound's value: every other size in these tests
    // derives from the constant, so a silent change is caught here, in the open.
    expect(CONTEXT_OUTPUT_LIMIT_BYTES).toBe(50_000)
    const reads = [
      expectOk(await stack.service.taskRead('s-c1')),
      expectOk(await stack.service.taskRead('s-root')),
      expectOk(await stack.service.taskStatus('s-g1')),
      expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph' })),
      expectOk(await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-root' })),
      expectOk(await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-c1' })),
      expectOk(await stack.service.contractProjection('s-g1')),
      expectOk(await stack.service.dynamicProjection('s-g1')),
    ]
    for (const read of reads) expect(utf8Bytes(read.text)).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
  })

  test('a handoff with more references than fit names what it did not show', async () => {
    const { stack, chain } = await chainStack()
    // A reference list is metered in whole rendered lines, so the fixture uses
    // wide ones: ~1 KB a line, with the artifacts alone the bound's worth of
    // references — more than the projection can show. The deployment's
    // runtime-split guidance rides after these lists and is not what this case
    // measures, so the switch is off and the projection ends with the lists.
    const lineWidth = 1_000
    stack.runtimeDecomposition = false
    stack.member(chain.graph, 's-refs')
    stack.sessionLog('s-refs', ['request'])
    await stack.seed({
      taskId: 't-refs',
      sessionId: 's-refs',
      runId: 'r-refs',
      objective: 'a task with a very long reference list',
      parentTaskId: 't-root',
      depth: 1,
    })
    const filler = 'x'.repeat(lineWidth)
    await stack.handoff({
      parentTaskId: 't-root',
      parentRunId: 'r-root',
      childTaskId: 't-refs',
      sessionId: chain.rootSession,
      parentObjective: 'build the release',
      reason: 'the reference list is longer than the bound',
      artifacts: Array.from({ length: CONTEXT_OUTPUT_LIMIT_BYTES / lineWidth + 10 }, (_, index) => ({
        artifactId: `a-${String(index).padStart(3, '0')}`,
        kind: 'fixture',
        uri: `out/${filler}-${String(index).padStart(3, '0')}.bin`,
      })),
      evidence: Array.from({ length: 3 }, (_, index) => `e-${filler}-${String(index).padStart(3, '0')}`),
    })
    const projection = expectOk(await stack.service.contractProjection('s-refs'))
    expect(utf8Bytes(projection.text)).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
    // Nothing is dropped silently: each list that was cut says how many entries
    // it did not show — the platform's own omission clause, followed by this
    // read's recovery sentence — and the cut lists are the handoff's own two
    // reference lists, in the order the projection renders them.
    expect(projection.text).toMatch(
      /Omitted \d+ items\. read them by id\n- relevant evidence:\nOmitted \d+ items\. read them by id/,
    )
  })

  test('a list of ordinary narrow references that does not fit still names its omission', async () => {
    const { stack, chain } = await chainStack()
    // The same shape with *narrow* entries — the ordinary case: thousands of
    // ordinary references overflow the bound, and the list must still say how
    // many it did not show. (The clause's room is reserved before each entry is
    // measured, so an entry can never eat it and turn the projection into a
    // refusal.)
    stack.runtimeDecomposition = false
    stack.member(chain.graph, 's-narrow')
    stack.sessionLog('s-narrow', ['request'])
    await stack.seed({
      taskId: 't-narrow',
      sessionId: 's-narrow',
      runId: 'r-narrow',
      objective: 'a task with many narrow references',
      parentTaskId: 't-root',
      depth: 1,
    })
    await stack.handoff({
      parentTaskId: 't-root',
      parentRunId: 'r-root',
      childTaskId: 't-narrow',
      sessionId: chain.rootSession,
      parentObjective: 'build the release',
      reason: 'the reference list is longer than the bound',
      artifacts: Array.from({ length: 6_000 }, (_, index) => ({
        artifactId: `a-${String(index).padStart(4, '0')}`,
        kind: 'fixture',
        uri: `out/${String(index).padStart(4, '0')}.bin`,
      })),
      evidence: ['e-plan', 'e-spec'],
    })
    const projection = expectOk(await stack.service.contractProjection('s-narrow'))
    expect(utf8Bytes(projection.text)).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
    // The artifacts were cut and said so — the room the clause needs was never
    // spent on an entry — and the evidence list after it still rendered, either
    // whole or with its own clause in the same words.
    expect(projection.text).toMatch(/Omitted \d+ items\. read them by id\n- relevant evidence:/)
    const evidenceSection = projection.text.slice(projection.text.indexOf('- relevant evidence:'))
    const whole = evidenceSection.includes('- evidence `e-plan`') && evidenceSection.includes('- evidence `e-spec`')
    expect(
      whole || /Omitted \d+ items\. read them by id/.test(evidenceSection),
      evidenceSection.slice(-400),
    ).toBe(true)
  })
})

describe('the byte window itself', () => {
  test('advances by character across BMP and astral characters alike', () => {
    // An astral character is one character in two UTF-16 code units; a window
    // that counts characters but cuts code units would start every page after one
    // of these one unit early (a lone surrogate, and a cursor inside a character).
    const emoji = '😀😀'
    expect(sliceUtf8(emoji, 0, 4)).toEqual({ text: '😀', nextOffset: 4, done: false })
    expect(sliceUtf8(emoji, 4, 4)).toEqual({ text: '😀', nextOffset: 8, done: true })
    expect(sliceUtf8(emoji, 8, 4)).toEqual({ text: '', nextOffset: 8, done: true })
    // A surrogate pair cut in half is *not* a boundary: the page starts at the
    // next character, and the cursor is the byte offset of a whole one.
    expect(sliceUtf8(emoji, 2, 4)).toEqual({ text: '😀', nextOffset: 8, done: true })
    // An offset inside the *last* character aligns to its end: there is no
    // character left to carry, so the page is empty and finished.
    expect(sliceUtf8(emoji, 6, 4)).toEqual({ text: '', nextOffset: 8, done: true })

    // A one-byte budget still advances, and a mixed body walks out whole. The
    // floor is the width of the character the page starts at, astral included.
    const mixed = '😀abc中文😀🎵'
    const parts: string[] = []
    let offset = 0
    for (let pages = 0; ; pages += 1) {
      const page = sliceUtf8(mixed, offset, 1)
      parts.push(page.text)
      if (page.done) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
      expect(pages).toBeLessThan(64)
    }
    expect(parts.join('')).toBe(mixed)
  })
})

describe('the named vocabulary', () => {
  test('is exactly the eight names the contract fixes', () => {
    expect([...NAMED_REFUSALS]).toEqual([
      'not-activated',
      'unbound',
      'binding-conflict',
      'cross-graph',
      'not-found',
      'stale-reference',
      'unreadable',
      'context-too-large',
    ])
  })

  test('every refusal a read answers with comes from that set', async () => {
    const { stack } = await chainStack()
    const refusals = [
      await stack.service.taskRead('s-stranger'),
      await stack.service.taskRead('s-bystander-unpublished'),
      await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-nope' }),
      await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-stranger' }),
    ]
    for (const result of refusals) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(NAMED_REFUSALS).toContain(result.refusal)
    }
  })
})

describe('cancellation', () => {
  test('an aborted signal stops a read instead of answering it', async () => {
    const { stack } = await chainStack()
    const controller = new AbortController()
    controller.abort()
    await expect(stack.service.taskRead('s-g1', controller.signal)).rejects.toThrow()
    await expect(stack.service.contextRead('s-g1', { kind: 'task', ref: 't-root' }, controller.signal)).rejects.toThrow()
    expect(expectRefused(await stack.service.taskRead('s-stranger'), 'unbound')).toBeDefined()
  })
})
