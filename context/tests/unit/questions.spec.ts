/**
 * The question plane (A4 §F.1, architecture §7.3) on the fixture's real store:
 * what a parent is shown about the questions it owes an answer to, what a child
 * is shown about the answers it has not been proven to have read, where
 * `waiting_answer` comes from, and what the output bound does to a list that
 * outgrows it.
 *
 * Every fact here is written through the store's own entries (`ask` →
 * `askParentQuestionIn`, `answer` → `answerParentQuestionIn`), so the records
 * the projection reads are the records the protocol commits. The one Session
 * fact the child side needs — "this message id was put in front of the model" —
 * is written the way DSH writes it, as a `user/message` event carrying that id.
 */

import { describe, expect, test } from 'vitest'
import { questionIdOf } from '../../../task/src/index.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, utf8Bytes } from '../../src/index.ts'
import { FixtureStack, expectOk, expectRefused, seedChain, type Chain } from '../support/stack.ts'

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

/** The identity one (asking run, request key) pair derives — the store's own derivation. */
const idOf = (childRunId: string, requestKey: string): string => questionIdOf({ childRunId, requestKey })

/** The reference text one `{sessionId, seq}` citation prints as, in the shape `context_read` takes. */
const refOf = (sessionId: string, seq: number): string => `{"sessionId":${JSON.stringify(sessionId)},"seq":${seq}}`

describe('the parent\'s view of the questions it owes an answer to', () => {
  test('an open question is shown with its asking run, its blocking flag and the reference to its body', async () => {
    const { stack } = await chainStack()
    const questionId = idOf('r-c1', 'k1')
    const asked = await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })

    const parent = expectOk(await stack.service.questionProjection('s-root'))
    expect(asked.questionId).toBe(questionId)
    expect(parent.text).toContain('# Pending questions (coordination)')
    expect(parent.text).toContain('role: root')
    expect(parent.text).toContain('## Questions waiting for your answer (1)')
    // The identity, the asking run, the task behind it, and the blocking flag.
    expect(parent.text).toContain(`- ${questionId} — from child run r-c1 (task t-c1), blocking: yes, asked `)
    // The body is a citation into the asking Session, read with `context_read`
    // — never a copy of the text.
    expect(parent.text).toContain(`ref:${refOf('s-c1', 0)}`)
    expect(parent.text).toContain('Answer a question with `task_answer` {questionId, requestKey, answer, resolves}')
    expect(parent.source).toContain('store sg-t-s-root')

    // The asking run is a child: it has nothing of its own to answer, and no
    // answer has arrived yet. A sibling that asked nothing is equally empty.
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toBe('')
    expect(expectOk(await stack.service.questionProjection('s-c2')).text).toBe('')
  })

  test('a non-blocking question is shown as blocking: no, and never becomes waiting_answer', async () => {
    const { stack } = await chainStack()
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1', blocking: false })
    expect(expectOk(await stack.service.questionProjection('s-root')).text).toContain('blocking: no')
    const read = expectOk(await stack.service.taskRead('s-c1'))
    expect(read.text).toContain('run r-c1 [running] — phase active')
    expect(read.text).not.toContain('waiting_answer')
  })

  test('a resolving answer takes the question out of the parent\'s view, a non-resolving one leaves it', async () => {
    const { stack } = await chainStack()
    const resolved = idOf('r-c1', 'k1')
    const kept = idOf('r-c1', 'k2')
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    const second = await stack.ask({ childRunId: 'r-c1', requestKey: 'k2' })
    expect(second.questionId).toBe(kept)
    await stack.answer({ questionId: resolved, requestKey: 'a1', resolves: true, messageId: 'm-a1' })
    await stack.answer({ questionId: kept, requestKey: 'a2', resolves: false, messageId: 'm-a2' })

    // The resolved question is gone from the parent's list; the one answered
    // "this does not resolve it" is still open there.
    const parent = expectOk(await stack.service.questionProjection('s-root'))
    expect(parent.text).toContain(`- ${kept} — from child run r-c1 (task t-c1), blocking: yes`)
    expect(parent.text).not.toContain(resolved)

    // Both answers are the child's unread items, and the unresolved one says so.
    const child = expectOk(await stack.service.questionProjection('s-c1'))
    expect(child.text).toContain('## Answers waiting to be read (2)')
    expect(child.text).toContain(`the answer to question ${kept}, resolves: no`)
    expect(child.text).toContain(`the answer to question ${resolved}, resolves: yes`)
    expect(child.text).not.toContain('## Questions waiting for your answer')
  })

  test('a parent that settles drops out of the view: nobody can answer, and nothing waits', async () => {
    const { stack } = await chainStack()
    const questionId = idOf('r-c1', 'k1')
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    expect(expectOk(await stack.service.questionProjection('s-root')).text).toContain(questionId)
    // The root's run is cancelled: the question stays on record as an audit of
    // what was asked, and stops being anybody's open item — the asking run
    // derives its own release from the same rule, with no cancellation event.
    await stack.task.markRunStatusIn('sg-t-s-root', 't-root', 'r-root', 'cancelled', 's-root', { reason: 'fixture stop' })
    expect(expectOk(await stack.service.questionProjection('s-root')).text).toBe('')
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toBe('')
    expect((await stack.snapshot('sg-t-s-root')).questions?.all).toHaveLength(1)
  })
})

describe('the child\'s view of the answers it has not been shown', () => {
  test('an answer is shown with its question, its resolution and the reference to its body', async () => {
    const { stack } = await chainStack()
    const questionId = idOf('r-c1', 'k1')
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    const answer = await stack.answer({ questionId, requestKey: 'a1', resolves: true, messageId: 'm-a1' })

    const child = expectOk(await stack.service.questionProjection('s-c1'))
    expect(child.text).toContain('## Answers waiting to be read (1)')
    expect(child.text).toContain(`- ${answer.answerId} — the answer to question ${questionId}, resolves: yes, answered `)
    expect(child.text).toContain(`ref:${refOf('s-root', 0)}`)
    expect(child.text).toContain('Read an answer at the reference on its line')
    // The parent's own view of that question is gone — it answered it.
    expect(expectOk(await stack.service.questionProjection('s-root')).text).toBe('')
  })

  test('the answer disappears only once the caller\'s own Session holds its message id as a user message', async () => {
    const { stack } = await chainStack()
    const questionId = idOf('r-c1', 'k1')
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    const answer = await stack.answer({ questionId, requestKey: 'a1', resolves: true, messageId: 'm-a1' })

    // A different message in the same log proves nothing: the fold is by id.
    stack.consumed('s-c1', 'm-some-other-message')
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toContain(answer.answerId)
    // Another session's log is not this caller's log.
    stack.consumed('s-c2', 'm-a1')
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toContain(answer.answerId)
    // The caller's own Session holds the identity: the model has been given it.
    stack.consumed('s-c1', 'm-a1')
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toBe('')
  })

  test('the proof is re-derived at every read, and nothing about it is persisted', async () => {
    const { stack } = await chainStack()
    const questionId = idOf('r-c1', 'k1')
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    const answer = await stack.answer({ questionId, requestKey: 'a1', resolves: true, messageId: 'm-a1' })
    const events = stack.storeEvents('sg-t-s-root').length

    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toContain(answer.answerId)
    // The whole rest of the read surface in between, twice: no read of the
    // question plane changes what a later one answers, and none of them writes.
    await stack.service.taskRead('s-c1')
    await stack.service.dynamicProjection('s-c1')
    await stack.service.contextRead('s-c1', { kind: 'session', ref: 's-root' })
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toContain(answer.answerId)
    expect(stack.storeEvents('sg-t-s-root').length).toBe(events)

    // The proof is the Session log's own record and nothing else: put the log
    // back to a state without the message and the answer is listed again, so no
    // consumed flag survived anywhere. With it, the entry is gone.
    stack.sessionLog('s-c1', ['request', 'follow-up'])
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toContain(answer.answerId)
    stack.consumed('s-c1', 'm-a1')
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toBe('')
    expect(stack.storeEvents('sg-t-s-root').length).toBe(events)
  })

  test('a Session log that cannot be read drops nothing: no proof, keep the reference', async () => {
    const { stack } = await chainStack()
    const questionId = idOf('r-c1', 'k1')
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    const answer = await stack.answer({ questionId, requestKey: 'a1', resolves: true, messageId: 'm-a1' })
    stack.breakSessionRead('s-c1')
    expect(expectOk(await stack.service.questionProjection('s-c1')).text).toContain(answer.answerId)
  })
})

describe('waiting_answer is derived from the question facts, never written', () => {
  test('an active run with an open blocking question reads waiting_answer, and reads active again once answered', async () => {
    const { stack, chain } = await chainStack()
    const questionId = idOf('r-c1', 'k1')
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })

    const read = expectOk(await stack.service.taskRead('s-c1'))
    expect(read.text).toContain('run r-c1 [running] — phase waiting_answer started ')
    expect(read.text).not.toContain('phase active')
    // The projection derives the same word from the same facts.
    expect(expectOk(await stack.service.dynamicProjection('s-c1')).text).toContain('phase waiting_answer')
    expect(expectOk(await stack.service.contextRead('s-c1', { kind: 'run', ref: 'r-c1' })).text).toContain('phase waiting_answer')
    // The record itself is unchanged: no phase change was written, and the run
    // still stands where the protocol left it.
    expect((await stack.snapshot(chain.storeId)).runs.find(run => run.runId === 'r-c1')?.executionPhase).toBe('active')
    const phaseEvents = stack.storeEvents(chain.storeId).filter(event => event.kind === 'RunPhaseChanged')
    expect(phaseEvents.map(event => event.runId)).not.toContain('r-c1')

    await stack.answer({ questionId, requestKey: 'a1', resolves: true, messageId: 'm-a1' })
    expect(expectOk(await stack.service.taskRead('s-c1')).text).toContain('run r-c1 [running] — phase active started ')
    expect(expectOk(await stack.service.dynamicProjection('s-c1')).text).toContain('phase active')
  })

  test('a waiting_children run keeps its own phase and its batch beside an open question', async () => {
    const { stack } = await chainStack()
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    await stack.runFacts({ taskId: 't-c1', runId: 'r-c1', sessionId: 's-c1', phase: 'waiting_children', batchId: 'b-r-c1-p-1' })

    const read = expectOk(await stack.service.taskRead('s-c1'))
    expect(read.text).toContain('phase waiting_children')
    expect(read.text).toContain('batch b-r-c1-p-1')
    expect(read.text).not.toContain('waiting_answer')
    expect(expectOk(await stack.service.dynamicProjection('s-c1')).text).toContain('phase waiting_children')
  })

  test('a related task\'s own open question shows in the caller\'s status line', async () => {
    const { stack } = await chainStack()
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    const status = expectOk(await stack.service.taskStatus('s-root'))
    expect(status.text).toContain('run: running — phase waiting_answer')
    // The sibling that asked nothing still reads the phase it stands in.
    expect(status.text).toContain('run: running — phase active')
  })
})

describe('the question plane is bounded and ordered', () => {
  test('a question list longer than the output bound is cut and says how much it left out', async () => {
    const { stack } = await chainStack()
    // Enough questions that their lines cannot all fit the bound: each entry
    // carries an id, a run, a task, a time and a citation.
    for (let index = 0; index < 250; index += 1) await stack.ask({ childRunId: 'r-c1', requestKey: `k-${index}` })

    const read = expectOk(await stack.service.questionProjection('s-root'))
    expect(utf8Bytes(read.text)).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
    expect(read.text).toContain('Omitted ')
    expect(read.text).toContain('the questions this view could not carry stay open in the store')
    // The guidance survives the list it follows.
    expect(read.text).toContain('Answer a question with `task_answer`')
    const shown = read.text.split('\n').filter(line => line.startsWith('- q-')).length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(250)
    // The oldest questions are the ones kept, in the store's own ask order.
    expect(read.text.indexOf(idOf('r-c1', 'k-0'))).toBeLessThan(read.text.indexOf(idOf('r-c1', 'k-1')))
  })

  test('two reads of unchanged facts are byte-identical, and a new question changes the text', async () => {
    const { stack } = await chainStack()
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k1' })
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k2' })
    const first = expectOk(await stack.service.questionProjection('s-root')).text
    expect(expectOk(await stack.service.questionProjection('s-root')).text).toBe(first)
    expect(first.indexOf(idOf('r-c1', 'k1'))).toBeLessThan(first.indexOf(idOf('r-c1', 'k2')))
    await stack.ask({ childRunId: 'r-c1', requestKey: 'k3' })
    const after = expectOk(await stack.service.questionProjection('s-root')).text
    expect(after).not.toBe(first)
    expect(after).toContain(idOf('r-c1', 'k3'))
  })
})

describe('a caller with no question plane', () => {
  test('a plain member and a reviewer hold no list; a session outside the domain is refused by name', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-bystander')
    stack.sessionLog('s-bystander', ['request'])
    expect(expectRefused(await stack.service.questionProjection('s-bystander'), 'unbound')).toContain('asks no parent')
    // No graph publishes this session and no ledger names it: a caller outside
    // the domain is refused, never answered with an empty list.
    expect(expectRefused(await stack.service.questionProjection('s-nowhere'), 'unbound')).toContain('not a published member')
    // A reviewer has no business Run: no question is its own to ask or answer.
    stack.bindingSource(stack.ledger({ rootStoreId: chain.storeId, taskId: 't-c1', actor: 's-root', at: '2026-09-25T00:00:00.000Z' }))
    expect(expectOk(await stack.service.questionProjection('s-review')).text).toBe('')
  })

  test('a graph whose root has no contract yet is not-activated', async () => {
    const stack = new FixtureStack()
    stack.graph({ id: 'g-empty', rootSessionId: 's-empty' })
    stack.sessionLog('s-empty', ['not admitted yet'])
    const detail = expectRefused(await stack.service.questionProjection('s-empty'), 'not-activated')
    expect(detail).toContain('not activated')
    expect(detail).toContain('no root contract has been accepted')
  })
})
