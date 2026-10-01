/** Parent/child questions (A4, plan §F.1): the durable fact that one child run asked its direct parent, and the answer. @module @dangosys/dsh-singularity-task/question */

import { canonicalize, sha256Hex } from './contract.ts'
import { requireIndex } from './service/checks/primitives.ts'
import type { RunId, TaskSnapshot } from './types.ts'

/** A citation into the Session that sent a question or an answer: which Session, and which seq in its log. */
export interface QuestionMessageRef {
  /** The sending run's Session — the Session the cited `tool/call` event lives in. */
  sessionId: string
  /** The seq of that `tool/call` event in the sending Session's log. */
  seq: number
}

/** What a caller states when asking (the payload of `QuestionAsked`, minus what the store derives and stamps): which run asks, the key that makes the request stable, the content digest of the question, the citation of the body, the message … */
export interface QuestionAsk {
  /** The run asking; its task's direct parent is the addressee. */
  childRunId: RunId
  /** The caller's stable request key (§F.1); one key per question, and re-sends repeat it. */
  requestKey: string
  /** SHA-256 of the question body as the sender wrote it — the content identity used for idempotency, never the body itself. */
  questionDigest: string
  /** Where the question's body is: the child session's own `tool/call` event. */
  questionRef: QuestionMessageRef
  /** The delivery identity the message carries into the parent's Session (agent-runtime's handle; the store records it so a retry re-delivers the same message). */
  messageId: string
  /** Whether an answer is required before the asking run may continue. */
  blocking: boolean
}

/** What a caller states when answering (the payload of `QuestionAnswered`, minus what the store derives and stamps). */
export interface QuestionAnswer {
  /** The question being answered. */
  questionId: string
  /** The answering run; must equal the question record's parent run. */
  parentRunId: RunId
  /** The caller's stable request key for this answer; several keys may answer one open question. */
  requestKey: string
  /** SHA-256 of the answer body as the sender wrote it — content identity for idempotency, never the body itself. */
  answerDigest: string
  /** The parent's declaration that the question is answered (true) or still open (false). Never a classification and never an authorization. */
  resolves: boolean
  /** Where the answer's body is: the parent session's own `tool/call` event. */
  answerRef: QuestionMessageRef
  /** The delivery identity the answer carries into the child's Session. */
  messageId: string
}

/** One stored question: the ask as it was written, plus the id it derives from, the parent run it was addressed to, the time the store recorded it, and the answers that have arrived. */
export interface QuestionRecord extends QuestionAsk {
  /** `q-` plus {@link questionIdOf}'s derivation from the run and the key. */
  questionId: string
  /** The run the question is addressed to: the parent task's current run when the question was recorded. */
  parentRunId: RunId
  /** When the ask was recorded, as the writer stated it. */
  askedAt: string
  /** The answers recorded so far, in application order; absent until the first one. */
  answers?: readonly QuestionAnswerRecord[]
}

/** One stored answer: the claim as it was written, plus the id it derives from and the time it was recorded. */
export interface QuestionAnswerRecord extends QuestionAnswer {
  /** `a-` plus {@link answerIdOf}'s derivation from the question and the key. */
  answerId: string
  /** When the answer was recorded, as the writer stated it. */
  answeredAt: string
}

/** The questions a snapshot holds, indexed by the one question a reader asks ("what does this run wait on?" is a filter, but "what was this id?" is not): every question in ask order, and by id. */
export interface TaskQuestionIndex {
  /** Every question the store holds, in ask order. */
  readonly all: readonly QuestionRecord[]
  /** `questionId` → the question, answers included. */
  readonly byId: Readonly<Record<string, QuestionRecord>>
}

/** What an ask returns: the stored record, and whether this call is the one that recorded it. */
export interface QuestionAskResult {
  readonly question: QuestionRecord
  readonly created: boolean
}

/** What an answer returns: the stored record, and whether this call is the one that recorded it. */
export interface QuestionAnswerResult {
  readonly answer: QuestionAnswerRecord
  readonly created: boolean
}

/** The identity a question id is derived from. Exactly these two fields: the asking run keeps two tasks' identical keys apart, and the key keeps two questions of one run apart, so a retry addresses the question it means. */
interface QuestionIdentity {
  childRunId: RunId
  requestKey: string
}

/** The identity an answer id is derived from: the question and the answering caller's key. The question already covers its asking run and its own key. */
interface QuestionAnswerIdentity {
  questionId: string
  requestKey: string
}

/** The `q-` prefix every question id carries, so an id is recognizable wherever it is printed. */
const QUESTION_ID_PREFIX = 'q-'

/** The `a-` prefix every answer id carries. */
const ANSWER_ID_PREFIX = 'a-'

/** The question id one (run, key) pair gets: `q-` plus SHA-256 over {@link canonicalize} of {@link QuestionIdentity}. */
export function questionIdOf(identity: QuestionIdentity): string {
  return `${QUESTION_ID_PREFIX}${sha256Hex(canonicalize(identity))}`
}

/** The answer id one (question, key) pair gets: `a-` plus SHA-256 over {@link canonicalize} of {@link QuestionAnswerIdentity}. */
export function answerIdOf(identity: QuestionAnswerIdentity): string {
  return `${ANSWER_ID_PREFIX}${sha256Hex(canonicalize(identity))}`
}

/** The question one id names, or `undefined` when the store holds none. A snapshot without a question index is refused rather than read as empty: a snapshot built by this build's reducer always carries the index (empty members included), so … */
export function questionOf(snapshot: TaskSnapshot, questionId: string): QuestionRecord | undefined {
  return questionIndex(snapshot).byId[questionId]
}

/** The questions one run asked that are still open, in ask order. Open means both halves: no answer has resolved it, and both runs are still running — the parent has to be able to answer, and a settled run is never blocked by anything again. */
export function openQuestionsOf(snapshot: TaskSnapshot, childRunId: RunId): QuestionRecord[] {
  return questionIndex(snapshot).all.filter(
    question => question.childRunId === childRunId && isOpen(snapshot, question),
  )
}

/** The open questions whose answers block the asking run — the derivation the write gate and the display read. `blocking: false` is a real question that is expected to be delivered and answered; it just never stops the run. */
export function blockingQuestionsOf(snapshot: TaskSnapshot, childRunId: RunId): QuestionRecord[] {
  return openQuestionsOf(snapshot, childRunId).filter(question => question.blocking)
}

/** The questions one parent run has been asked and has not resolved, in ask order — the parent-side pending list (§7.3: an unanswered question and an unread answer both keep their reference until the model has actually seen them). */
export function questionsAwaitingAnswerOf(snapshot: TaskSnapshot, parentRunId: RunId): QuestionRecord[] {
  return questionIndex(snapshot).all.filter(
    question => question.parentRunId === parentRunId && isOpen(snapshot, question),
  )
}

/** The snapshot's question index, or a refusal: an absent index is "cannot see", never "holds none" (see {@link questionOf}). */
function questionIndex(snapshot: TaskSnapshot): TaskQuestionIndex {
  return requireIndex(snapshot.questions, 'task: snapshot carries no question index')
}

/** Whether one stored question still blocks anything: unresolved, and both runs still running. */
function isOpen(snapshot: TaskSnapshot, question: QuestionRecord): boolean {
  if (question.answers?.some(answer => answer.resolves) === true) return false
  return isRunning(snapshot, question.childRunId) && isRunning(snapshot, question.parentRunId)
}

function isRunning(snapshot: TaskSnapshot, runId: RunId): boolean {
  return snapshot.runs.some(run => run.runId === runId && run.status === 'running')
}
