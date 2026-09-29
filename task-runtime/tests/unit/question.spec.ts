import { describe, expect, test } from 'vitest'
import { ExecutionGate } from '../../src/gate.ts'
import { TaskRuntime } from '../../src/index.ts'
import { answerMessageIdOf, applyStoreQuestionBlocking, parseCallArguments, pendingQuestionMessages, questionMessageIdOf, releaseAskingSessions } from '../../src/question.ts'
import type { QuestionAnswerRecord, QuestionRecord, RunId, TaskSnapshot } from '@dangosys/dsh-singularity-task'

/**
 * The question module's pure rules, away from any service: the identities a
 * delivery states, the argument shape a citation must have, which facts still
 * owe a message, and how the recovery pass pushes blocks onto the gate. The
 * end-to-end behaviour — the store's commits, the message in a real inbox, the
 * gate's decisions in the waterfall — lives in the integration specs
 * (`tests/integration/a4-question-*.spec.ts`); what is here is the part that has
 * no service in it at all.
 */

const NOW = '2026-09-25T00:00:00.000Z'

test('the runtime declares the session reader used by parent questions', () => {
  expect(TaskRuntime.inject).toContain('sessionQuery')
})

/** One stored question: the fields the derivations read, plus the identity they hang off. */
function question(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    questionId: 'q-1',
    childRunId: 'r-child',
    parentRunId: 'r-parent',
    requestKey: 'k1',
    questionDigest: 'a'.repeat(64),
    questionRef: { sessionId: 's-child', seq: 7 },
    messageId: 'm-q-1',
    blocking: true,
    askedAt: NOW,
    ...overrides,
  }
}

/** One stored answer to `q-1`: what an answer delivery hangs off. */
function answerRecord(overrides: Partial<QuestionAnswerRecord> = {}): QuestionAnswerRecord {
  return {
    answerId: 'a-1',
    questionId: 'q-1',
    parentRunId: 'r-parent',
    requestKey: 'a1',
    answerDigest: 'b'.repeat(64),
    resolves: false,
    answerRef: { sessionId: 's-parent', seq: 9 },
    messageId: 'm-a-1',
    answeredAt: NOW,
    ...overrides,
  }
}

/**
 * A snapshot as the derivations read it: the question index, the runs, and what
 * `isOpen` asks about them (which run is running). Built by hand on purpose — the
 * subject here is the reader's rule, not the store that wrote the facts, and the
 * store's own suite owns that half.
 */
function snapshot(questions: readonly QuestionRecord[], overrides: Partial<Record<RunId, string>> = {}): TaskSnapshot {
  const runs = ['r-child', 'r-parent', 'r-other'].map(runId => ({
    runId,
    taskId: runId,
    sessionId: `s-${runId}`,
    status: overrides[runId] ?? 'running',
    startedAt: NOW,
  }))
  return {
    questions: { all: [...questions], byId: Object.fromEntries(questions.map(item => [item.questionId, item])) },
    runs,
    tasks: [],
  } as unknown as TaskSnapshot
}

describe('the delivery identities', () => {
  test('are derived from the fact they carry, never minted', () => {
    expect(questionMessageIdOf('q-abc')).toBe('m-q-abc')
    expect(answerMessageIdOf('a-abc')).toBe('m-a-abc')
    // Same fact, same identity — in this process or after a restart.
    expect(questionMessageIdOf('q-abc')).toBe(questionMessageIdOf('q-abc'))
    // A question's identity and its answer's can never collide.
    expect(questionMessageIdOf('a-abc')).not.toBe(answerMessageIdOf('q-abc'))
  })
})

describe('parseCallArguments', () => {
  test('accepts a JSON object and refuses everything else by name', () => {
    expect(parseCallArguments({ name: 'task_ask_parent', arguments: '{"requestKey":"k1"}' })).toEqual({ requestKey: 'k1' })
    expect(() => parseCallArguments({ name: 'task_ask_parent', arguments: 'not json' })).toThrow(/are not JSON/)
    expect(() => parseCallArguments({ name: 'task_ask_parent', arguments: '[1,2]' })).toThrow(/not a JSON object/)
    expect(() => parseCallArguments({ name: 'task_ask_parent', arguments: '"a string"' })).toThrow(/not a JSON object/)
  })
})

describe('pendingQuestionMessages', () => {
  test('owes an open question its ask, and every answer its delivery while the asking run can read it', () => {
    const asked = question()
    const { messages, refused } = pendingQuestionMessages(snapshot([asked]))
    expect(refused).toEqual([])
    expect(messages.map(message => message.kind)).toEqual(['question'])
    expect(messages[0]).toMatchObject({
      kind: 'question',
      questionId: 'q-1',
      messageId: 'm-q-1',
      senderSessionId: 's-r-child',
      targetSessionId: 's-r-parent',
      ref: { sessionId: 's-child', seq: 7 },
    })

    // An answer to an open question is owed too — the framework has no proof the
    // model read it, and the asking run can still act on it.
    const answered = pendingQuestionMessages(snapshot([{ ...asked, answers: [answerRecord()] }]))
    expect(answered.messages.map(message => message.kind)).toEqual(['question', 'answer'])
    expect(answered.messages[1]).toMatchObject({ kind: 'answer', answerId: 'a-1', targetSessionId: 's-r-child', senderSessionId: 's-r-parent' })
  })

  test('owes nothing for a question whose asking run settled, and nothing for its answers', () => {
    const asked = question({ answers: [] })
    const settledChild = pendingQuestionMessages(snapshot([asked], { 'r-child': 'cancelled' }))
    expect(settledChild.messages).toEqual([])
    // The ask is owed only while the parent can still answer it: a settled parent
    // leaves the question on the record as audit, with nothing to send.
    const settledParent = pendingQuestionMessages(snapshot([asked], { 'r-parent': 'verified' }))
    expect(settledParent.messages).toEqual([])
  })

  test('reports a question whose runs are not both in the snapshot instead of addressing it wrongly', () => {
    const orphan = question({ parentRunId: 'r-missing' })
    const { messages, refused } = pendingQuestionMessages(snapshot([orphan]))
    expect(messages).toEqual([])
    expect(refused).toEqual([{
      subject: 'question "q-1"',
      messageId: 'm-q-1',
      status: 'refused',
      reason: 'the store holds the question without both of its runs, so neither the ask nor its answers can be addressed',
    }])
  })

  test('refuses a snapshot that cannot show questions at all rather than reading it as "none"', () => {
    expect(() => pendingQuestionMessages({ runs: [], tasks: [] } as unknown as TaskSnapshot)).toThrow(/carries no question index/)
  })
})

describe('releaseAskingSessions', () => {
  test("recomputes the block of every session whose question the settled run was asked", () => {
    const gate = new ExecutionGate()
    const first = question()
    const second = question({ questionId: 'q-2', childRunId: 'r-other', requestKey: 'k2', messageId: 'm-q-2' })
    const settled = snapshot([first, second], { 'r-parent': 'cancelled' })
    gate.setQuestionsBlocked('s-r-child', true)
    gate.setQuestionsBlocked('s-r-other', true)
    gate.setQuestionsBlocked('s-r-parent', true)

    releaseAskingSessions(gate, settled, 'r-parent')
    // Both asking runs are released — the addressee settled, so nothing of theirs
    // is open any more — and the settled run's own session is not this function's
    // subject (its gate is closed by the settlement, not by a release).
    expect(gate.questionsBlocked('s-r-child')).toBe(false)
    expect(gate.questionsBlocked('s-r-other')).toBe(false)
    expect(gate.questionsBlocked('s-r-parent')).toBe(true)
  })

  test('leaves a session blocked while another of its questions is still open', () => {
    const gate = new ExecutionGate()
    const toSettled = question()
    const toOpen = question({ questionId: 'q-2', parentRunId: 'r-other', requestKey: 'k2', messageId: 'm-q-2' })
    gate.setQuestionsBlocked('s-r-child', true)

    releaseAskingSessions(gate, snapshot([toSettled, toOpen]), 'r-parent')

    expect(gate.questionsBlocked('s-r-child')).toBe(true)
  })

  test('touches nothing for a question whose asking run is no longer running, and nothing it cannot see', () => {
    const gate = new ExecutionGate()
    gate.setQuestionsBlocked('s-r-child', false)
    const settledChild = snapshot([question()], { 'r-child': 'cancelled' })

    releaseAskingSessions(gate, settledChild, 'r-parent')

    expect(gate.questionsBlocked('s-r-child')).toBe(false)
    // A snapshot with no question index is "cannot see", and a settlement must not
    // fail on it: there is nothing to release and nothing to invent.
    expect(() => releaseAskingSessions(gate, { runs: [], tasks: [] } as unknown as TaskSnapshot, 'r-parent')).not.toThrow()
  })

  test('does not decide a value the gate already holds', () => {
    const gate = new ExecutionGate()
    gate.setQuestionsBlocked('s-r-child', false)
    const token = gate.decisionToken('s-r-child')

    releaseAskingSessions(gate, snapshot([question()], { 'r-parent': 'cancelled' }), 'r-parent')

    expect(gate.questionsBlocked('s-r-child')).toBe(false)
    expect(gate.decisionToken('s-r-child')).toBe(token)
  })
})

describe('applyStoreQuestionBlocking', () => {
  test('pushes the block every run derives, under the caller\u2019s token', () => {
    const gate = new ExecutionGate()
    const asked = question()
    applyStoreQuestionBlocking(gate, snapshot([asked]), () => 0)
    expect(gate.questionsBlocked('s-r-child')).toBe(true)
    expect(gate.questionsBlocked('s-r-parent')).toBe(false)

    // A decision of this process that landed while the read was in flight drops
    // the stale value, exactly as a store-derived phase is dropped.
    gate.setQuestionsBlocked('s-r-child', false)
    applyStoreQuestionBlocking(gate, snapshot([asked]), () => 0)
    expect(gate.questionsBlocked('s-r-child')).toBe(false)

    // The same snapshot applied under a current token blocks again.
    applyStoreQuestionBlocking(gate, snapshot([asked]), sessionId => gate.decisionToken(sessionId))
    expect(gate.questionsBlocked('s-r-child')).toBe(true)
    // A resolving answer releases it — the derivation, not a flag.
    const released = { ...asked, answers: [answerRecord({ resolves: true })] }
    applyStoreQuestionBlocking(gate, snapshot([released]), sessionId => gate.decisionToken(sessionId))
    expect(gate.questionsBlocked('s-r-child')).toBe(false)
  })
})
