import { describe, expect, test, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { canonicalize, sha256Hex } from '../../src/contract.ts'
import {
  answerIdOf,
  blockingQuestionsOf,
  openQuestionsOf,
  questionIdOf,
  questionOf,
  questionsAwaitingAnswerOf,
} from '../../src/question.ts'
import type { QuestionAnswer, QuestionAsk, QuestionRecord } from '../../src/question.ts'
import type {
  TaskEvent,
  TaskEventKind,
  TaskEventPayloads,
  TaskId,
  TaskInstance,
  TaskRun,
} from '../../src/types.ts'
import { TaskService } from '../../src/index.ts'
import { TaskState } from '../../src/service/state.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const STORE = 'sg-t-root-session'
const CHILD_SESSION = 's-child'
const PARENT_SESSION = 's-root'

/**
 * Fixed vectors: the SHA-256 of the canonical identity text, computed outside
 * this repository (`sha256sum` over the exact byte sequences spelled out in the
 * identity test below), so a change in the identity derivation shows up here
 * instead of being confirmed by the implementation against itself.
 */
const QUESTION_ID = 'q-38ac025f30e86b32d0058e7aa04b16ae2f044acc5b7676727f596fc887384feb'
const QUESTION_ID_K2 = 'q-eddd9b36609f92da845585d74ed8cfe21d2a7f928b2896f4c1ae33e7fd516288'
const ANSWER_ID = 'a-f9aca1d25e89eb34c6e181b698516082e5fec9655e94da27284b5a1219c48654'

const QUESTION_DIGEST = '1'.repeat(64)
const OTHER_QUESTION_DIGEST = '2'.repeat(64)
const ANSWER_DIGEST = '3'.repeat(64)
const OTHER_ANSWER_DIGEST = '4'.repeat(64)

function ev<K extends TaskEventKind>(
  kind: K,
  payload: TaskEventPayloads[K],
  init: { taskId?: TaskId; runId?: string; parentTaskId?: TaskId } = {},
): TaskEvent {
  return {
    kind,
    taskId: init.taskId ?? 'c1',
    runId: init.runId,
    parentTaskId: init.parentTaskId,
    timestamp: NOW,
    actor: 'test',
    payload,
    schemaVersion: 1,
  } as unknown as TaskEvent
}

function task(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    taskId: 't1',
    definitionRef: { taskType: 'build', version: 1 },
    objective: 'build the thing',
    depth: 0,
    acceptanceCriteria: [
      { criterionId: 'c1', description: 'compiles', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' },
    ],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    ...overrides,
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: 'cr',
    taskId: 'c1',
    sessionId: CHILD_SESSION,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...overrides,
  }
}

function questionAsk(overrides: Partial<QuestionAsk> = {}): QuestionAsk {
  return {
    childRunId: 'cr',
    requestKey: 'k1',
    questionDigest: QUESTION_DIGEST,
    questionRef: { sessionId: CHILD_SESSION, seq: 3 },
    messageId: 'm-q1',
    blocking: true,
    ...overrides,
  }
}

function questionAnswer(overrides: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return {
    questionId: QUESTION_ID,
    parentRunId: 'pr',
    requestKey: 'a1',
    answerDigest: ANSWER_DIGEST,
    resolves: false,
    answerRef: { sessionId: PARENT_SESSION, seq: 7 },
    messageId: 'm-a1',
    ...overrides,
  }
}

/** The stored shape of one ask, as the service builds it. */
function questionRecord(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    ...questionAsk(),
    questionId: QUESTION_ID,
    parentRunId: 'pr',
    askedAt: NOW,
    ...overrides,
  }
}

/** A store holding root task `root` (run `pr`) and its admitted child `c1` (run `cr`). */
function childParentState(): TaskState {
  const state = new TaskState('store')
  state.apply(ev('TaskCreated', { task: task({ taskId: 'root', decompositionStatus: 'decomposable' }) }, { taskId: 'root' }))
  state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: 'root' }))
  state.apply(ev('TaskStarted', {
    run: run({ runId: 'pr', taskId: 'root', sessionId: PARENT_SESSION, executionPhase: 'active' }),
  }, { taskId: 'root', runId: 'pr' }))
  state.apply(ev('TaskCreated', { task: task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }) }, { taskId: 'c1', parentTaskId: 'root' }))
  state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'c1' }))
  state.apply(ev('TaskStarted', { run: run({ executionPhase: 'active' }) }, { taskId: 'c1', runId: 'cr' }))
  return state
}

function askedState(overrides: Partial<QuestionRecord> = {}): TaskState {
  const state = childParentState()
  state.apply(ev('QuestionAsked', { question: questionRecord(overrides) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }))
  return state
}

describe('question identities', () => {
  test('a question id is q- plus sha256 over the canonical child run and request key', () => {
    expect(questionIdOf({ childRunId: 'cr', requestKey: 'k1' })).toBe(QUESTION_ID)
    expect(questionIdOf({ childRunId: 'cr', requestKey: 'k1' }))
      .toBe(`q-${sha256Hex(canonicalize({ childRunId: 'cr', requestKey: 'k1' }))}`)
    expect(questionIdOf({ childRunId: 'cr', requestKey: 'k1' })).toBe(`q-${sha256Hex('{"childRunId":"cr","requestKey":"k1"}')}`)
  })

  test('the identity covers both the run and the key', () => {
    expect(questionIdOf({ childRunId: 'cr2', requestKey: 'k1' })).not.toBe(QUESTION_ID)
    expect(questionIdOf({ childRunId: 'cr', requestKey: 'k2' })).toBe(QUESTION_ID_K2)
  })

  test('an answer id is a- plus sha256 over the canonical question id and request key', () => {
    expect(answerIdOf({ questionId: QUESTION_ID, requestKey: 'a1' })).toBe(ANSWER_ID)
    expect(answerIdOf({ questionId: QUESTION_ID, requestKey: 'a1' }))
      .toBe(`a-${sha256Hex(canonicalize({ questionId: QUESTION_ID, requestKey: 'a1' }))}`)
    expect(answerIdOf({ questionId: QUESTION_ID, requestKey: 'a1' }))
      .toBe(`a-${sha256Hex(`{"questionId":"${QUESTION_ID}","requestKey":"a1"}`)}`)
    expect(answerIdOf({ questionId: QUESTION_ID_K2, requestKey: 'a1' })).not.toBe(ANSWER_ID)
  })
})

describe('TaskState parent questions', () => {
  test('a question applies with its derived id, its parent run, and no answers', () => {
    const state = childParentState()
    state.apply(ev('QuestionAsked', { question: questionRecord() }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }))
    const stored = state.snapshot().questions?.byId[QUESTION_ID]
    expect(stored).toEqual(questionRecord())
    expect(stored?.answers).toBeUndefined()
    expect(questionOf(state.snapshot(), QUESTION_ID)).toEqual(questionRecord())
  })

  test('a non-blocking question is stored with its flag', () => {
    const state = askedState({ blocking: false })
    expect(state.snapshot().questions?.byId[QUESTION_ID]?.blocking).toBe(false)
  })

  test('an answer is appended, resolves:false keeps the question open, and resolves:true closes it', () => {
    const state = askedState()
    state.apply(ev('QuestionAnswered', { answer: { ...questionAnswer(), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }))
    let stored = state.snapshot().questions?.byId[QUESTION_ID]
    expect(stored?.answers).toEqual([{ ...questionAnswer(), answerId: ANSWER_ID, answeredAt: NOW }])
    expect(openQuestionsOf(state.snapshot(), 'cr')).toHaveLength(1)
    expect(blockingQuestionsOf(state.snapshot(), 'cr')).toHaveLength(1)

    const secondId = answerIdOf({ questionId: QUESTION_ID, requestKey: 'a2' })
    state.apply(ev('QuestionAnswered', {
      answer: { ...questionAnswer({ requestKey: 'a2', resolves: true, answerDigest: OTHER_ANSWER_DIGEST }), answerId: secondId, answeredAt: NOW },
    }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }))
    stored = state.snapshot().questions?.byId[QUESTION_ID]
    expect(stored?.answers).toHaveLength(2)
    expect(openQuestionsOf(state.snapshot(), 'cr')).toHaveLength(0)
    expect(blockingQuestionsOf(state.snapshot(), 'cr')).toHaveLength(0)
    expect(questionsAwaitingAnswerOf(state.snapshot(), 'pr')).toHaveLength(0)
  })

  const refusedAsks: Array<[string, TaskEvent, string]> = [
    ['a question whose id is not its identity', ev('QuestionAsked', { question: questionRecord({ questionId: 'q-made-up' }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'is not the identity'],
    ['a question on an unknown child run', ev('QuestionAsked', { question: questionRecord({ childRunId: 'ghost', questionId: questionIdOf({ childRunId: 'ghost', requestKey: 'k1' }) }) }, { taskId: 'c1', runId: 'ghost', parentTaskId: 'root' }), 'unknown run'],
    ['a question naming another task\'s run', ev('QuestionAsked', { question: questionRecord() }, { taskId: 'root', runId: 'cr', parentTaskId: 'root' }), 'of task "c1", not "root"'],
    ['a question whose envelope run is not the child run', ev('QuestionAsked', { question: questionRecord() }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }), 'envelope run id mismatch'],
    ['a question whose envelope names no parent task', ev('QuestionAsked', { question: questionRecord() }, { taskId: 'c1', runId: 'cr' }), 'parent task id "root"'],
    ['a question whose parent run is not the parent task\'s current run', ev('QuestionAsked', { question: questionRecord({ parentRunId: 'ghost' }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'names parent run "ghost"'],
    ['a question citing another session', ev('QuestionAsked', { question: questionRecord({ questionRef: { sessionId: 's-elsewhere', seq: 3 } }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'cites session "s-elsewhere"'],
    ['a question with a malformed content digest', ev('QuestionAsked', { question: questionRecord({ questionDigest: 'nope' }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'content digest'],
    ['a question without a request key', ev('QuestionAsked', { question: questionRecord({ requestKey: '' }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'request key must be a non-empty string'],
    ['a question without a message id', ev('QuestionAsked', { question: questionRecord({ messageId: '' }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'message id must be a non-empty string'],
    ['a question with a non-boolean blocking flag', ev('QuestionAsked', { question: questionRecord({ blocking: 'yes' as unknown as boolean }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'blocking must be a boolean'],
    ['a question with a malformed body reference', ev('QuestionAsked', { question: questionRecord({ questionRef: { sessionId: CHILD_SESSION, seq: -1 } }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'seq must be a non-negative integer'],
    ['a question without an ask time', ev('QuestionAsked', { question: questionRecord({ askedAt: '' }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'requires an ask time'],
    ['a question carrying answers', ev('QuestionAsked', { question: questionRecord({ answers: [] }) }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'is asked without answers'],
    ['a duplicate question id', ev('QuestionAsked', { question: questionRecord() }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'already exists'],
  ]

  test.each(refusedAsks)('refuses %s and leaves the snapshot untouched', (_name, event, message) => {
    const state = _name === 'a duplicate question id' ? askedState() : childParentState()
    const before = state.snapshot()
    expect(() => state.apply(event)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })

  const refusedAnswers: Array<[string, TaskEvent, string]> = [
    ['an answer whose id is not its identity', ev('QuestionAnswered', { answer: { ...questionAnswer(), answerId: 'a-made-up', answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }), 'is not the identity'],
    ['an answer to an unknown question', ev('QuestionAnswered', { answer: { ...questionAnswer({ questionId: 'q-ghost' }), answerId: answerIdOf({ questionId: 'q-ghost', requestKey: 'a1' }), answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }), 'unknown question'],
    ['an answer from the wrong parent run', ev('QuestionAnswered', { answer: { ...questionAnswer({ parentRunId: 'pr2' }), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'pr2', parentTaskId: 'root' }), 'was asked of run "pr"'],
    ['an answer whose envelope run is not the answering run', ev('QuestionAnswered', { answer: { ...questionAnswer(), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }), 'envelope run id mismatch'],
    ['an answer whose envelope task is not the child task', ev('QuestionAnswered', { answer: { ...questionAnswer(), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'root', runId: 'pr', parentTaskId: 'root' }), 'of task "c1", not "root"'],
    ['an answer whose envelope parent task disagrees', ev('QuestionAnswered', { answer: { ...questionAnswer(), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'other' }), 'must carry parent task id "root"'],
    ['an answer citing another session', ev('QuestionAnswered', { answer: { ...questionAnswer({ answerRef: { sessionId: 's-elsewhere', seq: 7 } }), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }), 'cites session "s-elsewhere"'],
    ['an answer with a malformed content digest', ev('QuestionAnswered', { answer: { ...questionAnswer({ answerDigest: 'nope' }), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }), 'content digest'],
    ['an answer with a non-boolean resolves flag', ev('QuestionAnswered', { answer: { ...questionAnswer({ resolves: 'yes' as unknown as boolean }), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }), 'resolves must be a boolean'],
    ['an answer without an answer time', ev('QuestionAnswered', { answer: { ...questionAnswer(), answerId: ANSWER_ID, answeredAt: '' } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }), 'requires an answer time'],
    ['a duplicate answer id', ev('QuestionAnswered', { answer: { ...questionAnswer(), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }), 'already exists'],
  ]

  test.each(refusedAnswers)('refuses %s and leaves the snapshot untouched', (name, event, message) => {
    const state = askedState()
    if (name === 'a duplicate answer id') {
      state.apply(ev('QuestionAnswered', { answer: { ...questionAnswer(), answerId: ANSWER_ID, answeredAt: NOW } }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }))
    }
    const before = state.snapshot()
    expect(() => state.apply(event)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })

  test('a late answer to a resolved question is refused', () => {
    const state = askedState()
    state.apply(ev('QuestionAnswered', {
      answer: { ...questionAnswer({ resolves: true }), answerId: ANSWER_ID, answeredAt: NOW },
    }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }))
    const before = state.snapshot()
    expect(() => state.apply(ev('QuestionAnswered', {
      answer: { ...questionAnswer({ requestKey: 'a2' }), answerId: answerIdOf({ questionId: QUESTION_ID, requestKey: 'a2' }), answeredAt: NOW },
    }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }))).toThrow('already resolved')
    expect(state.snapshot()).toEqual(before)
  })

  test('a question on a parentless task is refused', () => {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: task({ taskId: 'root', decompositionStatus: 'leaf' }) }, { taskId: 'root' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'root' }))
    state.apply(ev('TaskStarted', { run: run({ runId: 'pr', taskId: 'root', sessionId: PARENT_SESSION, executionPhase: 'active' }) }, { taskId: 'root', runId: 'pr' }))
    const before = state.snapshot()
    expect(() => state.apply(ev('QuestionAsked', {
      question: questionRecord({ childRunId: 'pr', questionId: questionIdOf({ childRunId: 'pr', requestKey: 'k1' }), questionRef: { sessionId: PARENT_SESSION, seq: 3 } }),
    }, { taskId: 'root', runId: 'pr' }))).toThrow('has no parent task')
    expect(state.snapshot()).toEqual(before)
  })

  test('an ask is refused once the child run settled and nothing is written', () => {
    const state = childParentState()
    state.apply(ev('TaskCancelled', { reason: 'abort' }, { taskId: 'c1', runId: 'cr' }))
    const before = state.snapshot()
    expect(() => state.apply(ev('QuestionAsked', { question: questionRecord() }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' })))
      .toThrow('is cancelled; a question requires a running run')
    expect(state.snapshot()).toEqual(before)
    expect(state.snapshot().questions?.all).toHaveLength(0)
  })

  test('an ask is refused once the parent run settled and nothing is written', () => {
    const state = childParentState()
    state.apply(ev('TaskCancelled', { reason: 'abort' }, { taskId: 'root', runId: 'pr' }))
    const before = state.snapshot()
    expect(() => state.apply(ev('QuestionAsked', { question: questionRecord() }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' })))
      .toThrow('is cancelled; a question requires a running parent run')
    expect(state.snapshot()).toEqual(before)
  })

  test('an answer is refused once either run settled, and the open question stays unanswered', () => {
    const answer = { ...questionAnswer(), answerId: ANSWER_ID, answeredAt: NOW }

    const childCancelled = askedState()
    childCancelled.apply(ev('TaskCancelled', { reason: 'abort' }, { taskId: 'c1', runId: 'cr' }))
    const beforeChild = childCancelled.snapshot()
    expect(() => childCancelled.apply(ev('QuestionAnswered', { answer }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' })))
      .toThrow('is cancelled; a question requires a running run')
    expect(childCancelled.snapshot()).toEqual(beforeChild)

    const parentCancelled = askedState()
    parentCancelled.apply(ev('TaskCancelled', { reason: 'abort' }, { taskId: 'root', runId: 'pr' }))
    const beforeParent = parentCancelled.snapshot()
    expect(() => parentCancelled.apply(ev('QuestionAnswered', { answer }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' })))
      .toThrow('is cancelled; a question requires a running parent run')
    expect(parentCancelled.snapshot()).toEqual(beforeParent)
  })
})

describe('question derivations', () => {
  test('an open question is the asking run\'s, unanswered, with both runs running', () => {
    const state = askedState()
    expect(openQuestionsOf(state.snapshot(), 'cr')).toEqual([questionRecord()])
    expect(blockingQuestionsOf(state.snapshot(), 'cr')).toEqual([questionRecord()])
    expect(questionsAwaitingAnswerOf(state.snapshot(), 'pr')).toEqual([questionRecord()])
    expect(openQuestionsOf(state.snapshot(), 'pr')).toEqual([])
    expect(questionsAwaitingAnswerOf(state.snapshot(), 'cr')).toEqual([])
  })

  test('a non-blocking question is open but not blocking', () => {
    const state = askedState({ blocking: false })
    expect(openQuestionsOf(state.snapshot(), 'cr')).toHaveLength(1)
    expect(blockingQuestionsOf(state.snapshot(), 'cr')).toHaveLength(0)
    expect(questionsAwaitingAnswerOf(state.snapshot(), 'pr')).toHaveLength(1)
  })

  test('two blocking questions are listed in ask order and each answer removes only its own', () => {
    const state = askedState()
    const second: QuestionRecord = questionRecord({ requestKey: 'k2', questionId: QUESTION_ID_K2, questionDigest: OTHER_QUESTION_DIGEST })
    state.apply(ev('QuestionAsked', { question: second }, { taskId: 'c1', runId: 'cr', parentTaskId: 'root' }))
    expect(blockingQuestionsOf(state.snapshot(), 'cr').map(item => item.questionId)).toEqual([QUESTION_ID, QUESTION_ID_K2])

    state.apply(ev('QuestionAnswered', {
      answer: {
        ...questionAnswer({ questionId: QUESTION_ID_K2, resolves: true }),
        answerId: answerIdOf({ questionId: QUESTION_ID_K2, requestKey: 'a1' }),
        answeredAt: NOW,
      },
    }, { taskId: 'c1', runId: 'pr', parentTaskId: 'root' }))
    expect(blockingQuestionsOf(state.snapshot(), 'cr').map(item => item.questionId)).toEqual([QUESTION_ID])
    expect(questionsAwaitingAnswerOf(state.snapshot(), 'pr').map(item => item.questionId)).toEqual([QUESTION_ID])
  })

  test('a terminal run voids its open questions without a further event', () => {
    const state = askedState()
    expect(blockingQuestionsOf(state.snapshot(), 'cr')).toHaveLength(1)
    state.apply(ev('TaskCancelled', { reason: 'abort' }, { taskId: 'c1', runId: 'cr' }))
    expect(openQuestionsOf(state.snapshot(), 'cr')).toHaveLength(0)
    expect(blockingQuestionsOf(state.snapshot(), 'cr')).toHaveLength(0)
    expect(questionsAwaitingAnswerOf(state.snapshot(), 'pr')).toHaveLength(0)
  })

  test('a snapshot without the question index is refused, never read as "no questions"', () => {
    const foreign = { ...new TaskState('store').snapshot(), questions: undefined }
    expect(() => questionOf(foreign, QUESTION_ID)).toThrow('carries no question index')
    expect(() => openQuestionsOf(foreign, 'cr')).toThrow('carries no question index')
    expect(() => blockingQuestionsOf(foreign, 'cr')).toThrow('carries no question index')
    expect(() => questionsAwaitingAnswerOf(foreign, 'pr')).toThrow('carries no question index')
  })
})

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

interface Harness {
  readonly ctx: unknown
  readonly sessions: Map<string, StoredSession>
  readonly changes: string[]
}

function harness(sessions = new Map<string, StoredSession>()): Harness {
  const changes: string[] = []
  const persistence = {
    list: vi.fn(async () => [...sessions.values()].map(item => ({ header: item.header }))),
    create: vi.fn(async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
    open: vi.fn(async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
  }
  const ctx = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: (execute: () => unknown) => { execute() },
    emit: (event: string, value: { id: string }) => {
      if (event === 'task/change') changes.push(value.id)
    },
    on: () => {},
    sessionPersistence: persistence,
  }
  return { ctx, sessions, changes }
}

function storedEvents(h: Harness): SessionEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events)
}

function persistedKinds(h: Harness): string[] {
  return storedEvents(h).map(item => (item.data as TaskEvent).kind)
}

function record(seq: number, data: TaskEvent): SessionEvent {
  return { type: 'task/event', seq: SessionSeq(seq), time: 0, data, ignorable: true } as SessionEvent
}

/** A store whose root task runs on `pr` and whose admitted child `c1` runs on `cr`. */
async function parentChildStore(): Promise<{ h: Harness; service: TaskService }> {
  const h = harness()
  const service = new TaskService(h.ctx as never)
  await service.createStore(STORE)
  await service.createTaskIn(STORE, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
  await service.admitTaskIn(STORE, 'root', 'tester', { decompositionStatus: 'decomposable' })
  await service.startRunIn(STORE, run({ runId: 'pr', taskId: 'root', sessionId: PARENT_SESSION, executionPhase: 'active' }), 'tester')
  await service.decomposeIn(STORE, 'root', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester')
  await service.startRunIn(STORE, run({ executionPhase: 'active' }), 'tester')
  return { h, service }
}

describe('TaskService parent question entries', () => {
  test('a child asks and its parent answers without a phase change', async () => {
    const { h, service } = await parentChildStore()
    const asked = await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    expect(asked.created).toBe(true)
    expect(asked.question).toEqual({ ...questionRecord(), askedAt: expect.any(String) })
    expect(persistedKinds(h).at(-1)).toBe('QuestionAsked')

    const beforeAnswer = persistedKinds(h).length
    const answered = await service.answerParentQuestionIn(STORE, questionAnswer(), 'parent')
    expect(answered.created).toBe(true)
    expect(answered.answer.answerId).toBe(ANSWER_ID)
    expect(answered.answer.answerId).toBe(answerIdOf({ questionId: QUESTION_ID, requestKey: 'a1' }))
    expect(persistedKinds(h).length - beforeAnswer).toBe(1)
    expect(persistedKinds(h).at(-1)).toBe('QuestionAnswered')

    const snapshot = await service.snapshotIn(STORE)
    expect(blockingQuestionsOf(snapshot, 'cr')).toHaveLength(1)
    expect(blockingQuestionsOf(snapshot, 'cr')[0]?.answers).toEqual([answered.answer])
    const run = await service.runIn(STORE, 'cr')
    expect(run.executionPhase).toBe('active')
    expect(run.pendingQuestionIds).toBeUndefined()
    expect(run.blockingQuestionIds).toBeUndefined()
  })

  test('answers remove only their own block and a resolves:false answer keeps its question open', async () => {
    const { service } = await parentChildStore()
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    await service.askParentQuestionIn(STORE, questionAsk({ requestKey: 'k2', questionDigest: OTHER_QUESTION_DIGEST }), 'child')
    expect(blockingQuestionsOf(await service.snapshotIn(STORE), 'cr')).toHaveLength(2)

    await service.answerParentQuestionIn(STORE, questionAnswer({
      questionId: QUESTION_ID_K2,
      requestKey: 'a1',
      resolves: true,
      answerDigest: OTHER_ANSWER_DIGEST,
    }), 'parent')
    let snapshot = await service.snapshotIn(STORE)
    expect(blockingQuestionsOf(snapshot, 'cr').map(item => item.questionId)).toEqual([QUESTION_ID])
    expect(openQuestionsOf(snapshot, 'cr').map(item => item.questionId)).toEqual([QUESTION_ID])

    await service.answerParentQuestionIn(STORE, questionAnswer({ resolves: false }), 'parent')
    snapshot = await service.snapshotIn(STORE)
    expect(blockingQuestionsOf(snapshot, 'cr').map(item => item.questionId)).toEqual([QUESTION_ID])
    expect(openQuestionsOf(snapshot, 'cr').map(item => item.questionId)).toEqual([QUESTION_ID])
    expect(questionsAwaitingAnswerOf(snapshot, 'pr').map(item => item.questionId)).toEqual([QUESTION_ID])
    const first = questionOf(snapshot, QUESTION_ID)
    expect(first?.answers).toHaveLength(1)
    expect(first?.answers?.[0]?.resolves).toBe(false)

    await service.answerParentQuestionIn(STORE, questionAnswer({ requestKey: 'a2', resolves: true }), 'parent')
    snapshot = await service.snapshotIn(STORE)
    expect(blockingQuestionsOf(snapshot, 'cr')).toHaveLength(0)
    expect(openQuestionsOf(snapshot, 'cr')).toHaveLength(0)
    expect(questionOf(snapshot, QUESTION_ID)?.answers).toHaveLength(2)
  })

  test('a non-blocking question is delivered and never blocks', async () => {
    const { service } = await parentChildStore()
    const asked = await service.askParentQuestionIn(STORE, questionAsk({ blocking: false, requestKey: 'k2' }), 'child')
    expect(asked.question.blocking).toBe(false)
    const snapshot = await service.snapshotIn(STORE)
    expect(openQuestionsOf(snapshot, 'cr')).toHaveLength(1)
    expect(blockingQuestionsOf(snapshot, 'cr')).toHaveLength(0)
  })

  test('a repeated ask with the same content returns the original record and writes nothing', async () => {
    const { h, service } = await parentChildStore()
    const first = await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    const before = persistedKinds(h)
    const snapshotBefore = await service.snapshotIn(STORE)
    const again = await service.askParentQuestionIn(STORE, questionAsk({ messageId: 'm-q1-retry' }), 'child')
    expect(again.created).toBe(false)
    expect(again.question).toEqual(first.question)
    expect(persistedKinds(h)).toEqual(before)
    expect(await service.snapshotIn(STORE)).toEqual(snapshotBefore)
  })

  test('a repeated answer with the same content returns the original record and writes nothing', async () => {
    const { h, service } = await parentChildStore()
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    const first = await service.answerParentQuestionIn(STORE, questionAnswer({ resolves: true }), 'parent')
    const before = persistedKinds(h)
    const snapshotBefore = await service.snapshotIn(STORE)
    const again = await service.answerParentQuestionIn(STORE, questionAnswer({ resolves: true }), 'parent')
    expect(again.created).toBe(false)
    expect(again.answer).toEqual(first.answer)
    expect(persistedKinds(h)).toEqual(before)
    expect(await service.snapshotIn(STORE)).toEqual(snapshotBefore)
  })

  test('a repeated answer is idempotent even after a later answer resolved the question', async () => {
    const { h, service } = await parentChildStore()
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    await service.answerParentQuestionIn(STORE, questionAnswer({ requestKey: 'a1', resolves: true }), 'parent')
    const before = persistedKinds(h)
    const again = await service.answerParentQuestionIn(STORE, questionAnswer({ requestKey: 'a1', resolves: true }), 'parent')
    expect(again.created).toBe(false)
    expect(again.answer.answerId).toBe(ANSWER_ID)
    expect(persistedKinds(h)).toEqual(before)
  })

  test('a same-key ask with different content is refused and writes nothing', async () => {
    const { h, service } = await parentChildStore()
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    const before = persistedKinds(h)
    const snapshotBefore = await service.snapshotIn(STORE)
    await expect(service.askParentQuestionIn(STORE, questionAsk({ questionDigest: OTHER_QUESTION_DIGEST }), 'child'))
      .rejects.toThrow(`request key "k1" is already bound to question "${QUESTION_ID}"`)
    expect(persistedKinds(h)).toEqual(before)
    expect(await service.snapshotIn(STORE)).toEqual(snapshotBefore)
  })

  test('a same-key ask that flips the blocking declaration is refused and writes nothing', async () => {
    const { h, service } = await parentChildStore()
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    const before = persistedKinds(h)
    await expect(service.askParentQuestionIn(STORE, questionAsk({ blocking: false }), 'child'))
      .rejects.toThrow('blocking declaration')
    expect(persistedKinds(h)).toEqual(before)
    expect(questionOf(await service.snapshotIn(STORE), QUESTION_ID)?.blocking).toBe(true)
  })

  test('a same-key answer with different content is refused and writes nothing', async () => {
    const { h, service } = await parentChildStore()
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    await service.answerParentQuestionIn(STORE, questionAnswer(), 'parent')
    const before = persistedKinds(h)
    await expect(service.answerParentQuestionIn(STORE, questionAnswer({ answerDigest: OTHER_ANSWER_DIGEST }), 'parent'))
      .rejects.toThrow('request key "a1" is already bound to answer "' + ANSWER_ID + '"')
    await expect(service.answerParentQuestionIn(STORE, questionAnswer({ resolves: true }), 'parent'))
      .rejects.toThrow('resolves declaration')
    expect(persistedKinds(h)).toEqual(before)
  })

  test('an answer from a run that is not the question\'s parent is refused', async () => {
    const { h, service } = await parentChildStore()
    await service.createTaskIn(STORE, task({ taskId: 'c2', parentTaskId: 'root', depth: 1 }), 'tester')
    await service.admitTaskIn(STORE, 'c2', 'tester', { decompositionStatus: 'leaf' })
    await service.startRunIn(STORE, run({ runId: 'cr2', taskId: 'c2', sessionId: 's-sibling', executionPhase: 'active' }), 'tester')
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    const before = persistedKinds(h)
    const snapshotBefore = await service.snapshotIn(STORE)
    await expect(service.answerParentQuestionIn(STORE, questionAnswer({
      parentRunId: 'cr2',
      answerRef: { sessionId: 's-sibling', seq: 7 },
    }), 'sibling')).rejects.toThrow('was asked of run "pr"')
    expect(persistedKinds(h)).toEqual(before)
    expect(await service.snapshotIn(STORE)).toEqual(snapshotBefore)
  })

  test('an ask from a parentless task is refused and writes nothing', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task({ taskId: 'root' }), 'tester')
    await service.admitTaskIn(STORE, 'root', 'tester', { decompositionStatus: 'leaf' })
    await service.startRunIn(STORE, run({ runId: 'pr', taskId: 'root', sessionId: PARENT_SESSION, executionPhase: 'active' }), 'tester')
    const before = persistedKinds(h)
    const snapshotBefore = await service.snapshotIn(STORE)
    await expect(service.askParentQuestionIn(STORE, questionAsk({
      childRunId: 'pr',
      questionRef: { sessionId: PARENT_SESSION, seq: 3 },
    }), 'root')).rejects.toThrow('has no parent task')
    expect(persistedKinds(h)).toEqual(before)
    expect(await service.snapshotIn(STORE)).toEqual(snapshotBefore)
  })

  test('a question citing a foreign session is refused before anything is written', async () => {
    const { h, service } = await parentChildStore()
    const before = persistedKinds(h)
    await expect(service.askParentQuestionIn(STORE, questionAsk({ questionRef: { sessionId: PARENT_SESSION, seq: 3 } }), 'child'))
      .rejects.toThrow('cites session "s-root"')
    expect(persistedKinds(h)).toEqual(before)

    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    await expect(service.answerParentQuestionIn(STORE, questionAnswer({ answerRef: { sessionId: CHILD_SESSION, seq: 7 } }), 'parent'))
      .rejects.toThrow('cites session "s-child"')
    expect(persistedKinds(h)).toHaveLength(before.length + 1)
  })

  test('a late answer after a terminal run is refused and leaves no new fact', async () => {
    const { h, service } = await parentChildStore()
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    await service.markRunStatusIn(STORE, 'c1', 'cr', 'cancelled', 'tester', { reason: 'abort' })
    const before = persistedKinds(h)
    const snapshotBefore = await service.snapshotIn(STORE)
    await expect(service.answerParentQuestionIn(STORE, questionAnswer(), 'parent'))
      .rejects.toThrow('is cancelled; a question requires a running run')
    expect(persistedKinds(h)).toEqual(before)
    expect(await service.snapshotIn(STORE)).toEqual(snapshotBefore)
  })

  test('an ask after its child run settled is refused and leaves no new fact', async () => {
    const { h, service } = await parentChildStore()
    await service.markRunStatusIn(STORE, 'c1', 'cr', 'cancelled', 'tester', { reason: 'abort' })
    const before = persistedKinds(h)
    const snapshotBefore = await service.snapshotIn(STORE)
    await expect(service.askParentQuestionIn(STORE, questionAsk(), 'child'))
      .rejects.toThrow('is cancelled; a question requires a running run')
    expect(persistedKinds(h)).toEqual(before)
    expect(await service.snapshotIn(STORE)).toEqual(snapshotBefore)
  })

  test('an answer to an unknown question is refused by name', async () => {
    const { h, service } = await parentChildStore()
    const before = persistedKinds(h)
    await expect(service.answerParentQuestionIn(STORE, questionAnswer(), 'parent')).rejects.toThrow('unknown question')
    expect(persistedKinds(h)).toEqual(before)
  })

  test('a reopened store derives the same identities, answers and blocking state', async () => {
    const { h, service } = await parentChildStore()
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    await service.askParentQuestionIn(STORE, questionAsk({ requestKey: 'k2', questionDigest: OTHER_QUESTION_DIGEST, blocking: false }), 'child')
    await service.answerParentQuestionIn(STORE, questionAnswer({ resolves: false }), 'parent')
    const before = await service.snapshotIn(STORE)
    const events = persistedKinds(h)

    const reopened = new TaskService(h.ctx as never)
    const snapshot = await reopened.openStore(STORE)
    expect(snapshot).toEqual(before)
    expect(persistedKinds(h)).toEqual(events)
    expect(questionOf(snapshot, QUESTION_ID)?.questionId).toBe(QUESTION_ID)
    expect(questionOf(snapshot, QUESTION_ID)?.answers?.[0]?.answerId).toBe(ANSWER_ID)
    expect(openQuestionsOf(snapshot, 'cr').map(item => item.questionId)).toEqual([QUESTION_ID, QUESTION_ID_K2])
    expect(blockingQuestionsOf(snapshot, 'cr').map(item => item.questionId)).toEqual([QUESTION_ID])
    expect(questionsAwaitingAnswerOf(snapshot, 'pr').map(item => item.questionId)).toEqual([QUESTION_ID, QUESTION_ID_K2])
  })

  test('an idempotent retry after a reopen still returns the original record', async () => {
    const { h, service } = await parentChildStore()
    const first = await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    const reopened = new TaskService(h.ctx as never)
    await reopened.openStore(STORE)
    const before = persistedKinds(h)
    const again = await reopened.askParentQuestionIn(STORE, questionAsk(), 'child')
    expect(again.created).toBe(false)
    expect(again.question).toEqual(first.question)
    expect(persistedKinds(h)).toEqual(before)
  })

  test('new writes never carry the A3 question-id fields, old records stay readable', async () => {
    const { h, service } = await parentChildStore()
    await service.changeRunPhaseIn(STORE, 'root', 'pr', 'tester', { phase: 'waiting_children', batchId: 'b-root' })
    await service.askParentQuestionIn(STORE, questionAsk(), 'child')
    for (const stored of storedEvents(h)) {
      const data = stored.data as TaskEvent
      if (data.kind !== 'RunPhaseChanged') continue
      expect(data.payload.pendingQuestionIds).toBeUndefined()
      expect(data.payload.blockingQuestionIds).toBeUndefined()
    }
    const questionEvent = storedEvents(h).map(item => item.data as TaskEvent).find(item => item.kind === 'QuestionAsked')
    expect(questionEvent?.payload).toEqual({ question: { ...questionRecord(), askedAt: expect.any(String) } })

    const before = persistedKinds(h)
    await expect(service.changeRunPhaseIn(STORE, 'c1', 'cr', 'tester', {
      phase: 'submitted',
      submission: { summary: 'done', evidenceRefs: [], submittedAt: NOW, origin: 'worker' },
      pendingQuestionIds: [QUESTION_ID],
    })).rejects.toThrow('pendingQuestionIds')
    expect(persistedKinds(h)).toEqual(before)
  })

  test('an old record carrying question ids replays unchanged and stays readable', async () => {
    const sessions = new Map<string, StoredSession>()
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: makeSessionId(STORE), createdAt: 0, isSeeded: false }
    sessions.set(STORE, {
      header,
      events: [
        record(0, ev('TaskCreated', { task: task({ taskId: 'root', decompositionStatus: 'decomposable' }) }, { taskId: 'root' })),
        record(1, ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: 'root' })),
        record(2, ev('TaskStarted', { run: run({ runId: 'pr', taskId: 'root', sessionId: PARENT_SESSION, executionPhase: 'active' }) }, { taskId: 'root', runId: 'pr' })),
        record(3, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-root', pendingQuestionIds: ['q-old'], blockingQuestionIds: ['q-old'] }, { taskId: 'root', runId: 'pr' })),
      ],
    })
    const h = harness(sessions)
    const service = new TaskService(h.ctx as never)
    const snapshot = await service.openStore(STORE)
    const storedRun = snapshot.runs[0]
    expect(storedRun?.executionPhase).toBe('waiting_children')
    expect(storedRun?.pendingQuestionIds).toEqual(['q-old'])
    expect(storedRun?.blockingQuestionIds).toEqual(['q-old'])
    expect(snapshot.questions).toEqual({ all: [], byId: {} })
    expect(blockingQuestionsOf(snapshot, 'pr')).toHaveLength(0)
  })
})
