/** Question and answer reducer handlers. @module @dangosys/dsh-singularity-task/service/questions */

import { answerIdOf, questionIdOf } from '../question.ts'
import type { QuestionAnswerRecord, QuestionRecord, TaskQuestionIndex } from '../question.ts'
import type { RunId, TaskId, TaskSnapshot } from '../types.ts'
import { copy, isDigest, isRecord, nonEmpty, requireIndex, runIn, taskIn } from './checks/primitives.ts'
import { assertMessageRef } from './checks/runs.ts'

/** The snapshot's question index, or a refusal: an absent index is "cannot see", never "holds none". */
export function questionIndex(snapshot: TaskSnapshot): TaskQuestionIndex {
  return requireIndex(snapshot.questions, 'task: snapshot carries no question index')
}

/** A child run asks its direct parent (A4 §F.1). The reducer is the gate for the whole shape, in this order: the record must be well-formed, its id must be the identity its own (child run, request key) pair derives, the asking run must exist … */
export function askQuestion(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  envelopeRunId: RunId | undefined,
  envelopeParentTaskId: TaskId | undefined,
  question: QuestionRecord,
): TaskSnapshot {
  if (!isRecord(question)) throw new Error('task: question must be an object')
  if (!nonEmpty(question.questionId)) throw new Error('task: question id must be a non-empty string')
  const id = question.questionId
  if (!nonEmpty(question.requestKey)) throw new Error(`task: question "${id}" request key must be a non-empty string`)
  if (!nonEmpty(question.messageId)) throw new Error(`task: question "${id}" message id must be a non-empty string`)
  if (!isDigest(question.questionDigest))
    throw new Error(`task: question "${id}" content digest must be a lowercase SHA-256 hex digest`)
  if (typeof question.blocking !== 'boolean') throw new Error(`task: question "${id}" blocking must be a boolean`)
  if (!nonEmpty(question.askedAt)) throw new Error(`task: question "${id}" requires an ask time`)
  if (question.answers !== undefined)
    throw new Error(`task: question "${id}" is asked without answers; an answer is its own event`)
  assertMessageRef(`question "${id}"`, question.questionRef)
  const derived = questionIdOf({ childRunId: question.childRunId, requestKey: question.requestKey })
  if (id !== derived) {
    throw new Error(
      `task: question id "${id}" is not the identity of child run "${question.childRunId}" and request key "${question.requestKey}" ("${derived}")`,
    )
  }
  const child = runIn(snapshot, question.childRunId)
  if (envelopeRunId !== child.runId) {
    throw new Error(
      `task: question "${id}" envelope run id mismatch: the asking run is "${child.runId}", the envelope names "${String(envelopeRunId)}"`,
    )
  }
  const childTask = taskIn(snapshot, child.taskId)
  if (taskId !== childTask.taskId) {
    throw new Error(
      `task: question "${id}" is asked by run "${child.runId}" of task "${childTask.taskId}", not "${taskId}"`,
    )
  }
  if (child.status !== 'running') {
    throw new Error(`task: child run "${child.runId}" is ${child.status}; a question requires a running run`)
  }
  if (childTask.parentTaskId === undefined) {
    throw new Error(
      `task: task "${childTask.taskId}" has no parent task; a root or parentless replay task cannot ask a parent`,
    )
  }
  const parentTask = taskIn(snapshot, childTask.parentTaskId)
  if (envelopeParentTaskId !== parentTask.taskId) {
    throw new Error(
      `task: question "${id}" must carry parent task id "${parentTask.taskId}"; the envelope names "${String(envelopeParentTaskId)}"`,
    )
  }
  const parentRunId = parentTask.runIds[parentTask.runIds.length - 1]
  if (parentRunId === undefined)
    throw new Error(`task: parent task "${parentTask.taskId}" has no run for question "${id}"`)
  const parentRun = runIn(snapshot, parentRunId)
  if (question.parentRunId !== parentRun.runId) {
    throw new Error(
      `task: question "${id}" names parent run "${question.parentRunId}"; task "${parentTask.taskId}"'s current run is "${parentRun.runId}"`,
    )
  }
  if (parentRun.status !== 'running') {
    throw new Error(
      `task: parent run "${parentRun.runId}" is ${parentRun.status}; a question requires a running parent run`,
    )
  }
  if (question.questionRef.sessionId !== child.sessionId) {
    throw new Error(
      `task: question "${id}" cites session "${question.questionRef.sessionId}"; the asking run's session is "${child.sessionId}"`,
    )
  }
  const index = questionIndex(snapshot)
  if (index.byId[id] !== undefined) throw new Error(`task: question "${id}" already exists`)
  const stored = copy(question)
  snapshot = {
    ...snapshot,
    questions: { all: [...index.all, stored], byId: { ...index.byId, [id]: stored } },
  }
  return snapshot
}

/** A parent run answers one of its children's questions (A4 §F.1). An answer is appended to the question's record, so the reducer's job is to decide whether this answer may join *this* question: the id must be the one its (question, request … */
export function answerQuestion(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  envelopeRunId: RunId | undefined,
  envelopeParentTaskId: TaskId | undefined,
  answer: QuestionAnswerRecord,
): TaskSnapshot {
  if (!isRecord(answer)) throw new Error('task: answer must be an object')
  if (!nonEmpty(answer.answerId)) throw new Error('task: answer id must be a non-empty string')
  const id = answer.answerId
  if (!nonEmpty(answer.questionId)) throw new Error(`task: answer "${id}" question id must be a non-empty string`)
  if (!nonEmpty(answer.requestKey)) throw new Error(`task: answer "${id}" request key must be a non-empty string`)
  if (!nonEmpty(answer.messageId)) throw new Error(`task: answer "${id}" message id must be a non-empty string`)
  if (!isDigest(answer.answerDigest))
    throw new Error(`task: answer "${id}" content digest must be a lowercase SHA-256 hex digest`)
  if (typeof answer.resolves !== 'boolean') throw new Error(`task: answer "${id}" resolves must be a boolean`)
  if (!nonEmpty(answer.answeredAt)) throw new Error(`task: answer "${id}" requires an answer time`)
  assertMessageRef(`answer "${id}"`, answer.answerRef)
  const derived = answerIdOf({ questionId: answer.questionId, requestKey: answer.requestKey })
  if (id !== derived) {
    throw new Error(
      `task: answer id "${id}" is not the identity of question "${answer.questionId}" and request key "${answer.requestKey}" ("${derived}")`,
    )
  }
  const question = questionIndex(snapshot).byId[answer.questionId]
  if (question === undefined) throw new Error(`task: unknown question "${answer.questionId}"`)
  if (answer.parentRunId !== question.parentRunId) {
    throw new Error(
      `task: answer "${id}" names parent run "${answer.parentRunId}"; question "${question.questionId}" was asked of run "${question.parentRunId}"`,
    )
  }
  const child = runIn(snapshot, question.childRunId)
  const parent = runIn(snapshot, question.parentRunId)
  if (child.status !== 'running') {
    throw new Error(
      `task: question "${question.questionId}" is not open: child run "${child.runId}" is ${child.status}; a question requires a running run`,
    )
  }
  if (parent.status !== 'running') {
    throw new Error(
      `task: question "${question.questionId}" is not open: parent run "${parent.runId}" is ${parent.status}; a question requires a running parent run`,
    )
  }
  if (answer.answerRef.sessionId !== parent.sessionId) {
    throw new Error(
      `task: answer "${id}" cites session "${answer.answerRef.sessionId}"; the answering run's session is "${parent.sessionId}"`,
    )
  }
  if (envelopeRunId !== parent.runId) {
    throw new Error(
      `task: answer "${id}" envelope run id mismatch: the answering run is "${parent.runId}", the envelope names "${String(envelopeRunId)}"`,
    )
  }
  const childTask = taskIn(snapshot, child.taskId)
  if (taskId !== childTask.taskId) {
    throw new Error(
      `task: answer "${id}" belongs to run "${child.runId}" of task "${childTask.taskId}", not "${taskId}"`,
    )
  }
  if (envelopeParentTaskId !== parent.taskId) {
    throw new Error(
      `task: answer "${id}" must carry parent task id "${parent.taskId}"; the envelope names "${String(envelopeParentTaskId)}"`,
    )
  }
  const answers = question.answers ?? []
  if (answers.some(item => item.resolves)) {
    throw new Error(`task: question "${question.questionId}" is already resolved; answer "${id}" is refused`)
  }
  if (answers.some(item => item.answerId === id)) throw new Error(`task: answer "${id}" already exists`)
  const stored: QuestionRecord = { ...question, answers: [...answers, copy(answer)] }
  const replace = (questions: readonly QuestionRecord[]): QuestionRecord[] =>
    questions.map(item => (item.questionId === question.questionId ? stored : item))
  snapshot = {
    ...snapshot,
    questions: {
      all: replace(questionIndex(snapshot).all),
      byId: { ...questionIndex(snapshot).byId, [question.questionId]: stored },
    },
  }
  return snapshot
}
