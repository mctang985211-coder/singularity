/**
 * Parent/child questions (A4, plan §F.1): the durable fact that one child run
 * asked its direct parent something, and that the parent answered it — the
 * identity, the two runs, the citation into the sender's Session, and the
 * blocking effect, and nothing else.
 *
 * Why the body is not here: a question and an answer are messages, and the
 * Session that sent one already persists it (`tool/call`). The store keeps a
 * {@link QuestionMessageRef} — the sending Session and the seq of that call —
 * so a reader can go and read what was asked, while the task store stays the
 * owner of what the framework *did* about it: which run waits, on which
 * question, and whether an answer released it. Copying the text here would make
 * two sources for one sentence, and a summarized or re-encoded copy could
 * disagree with the message the model actually saw.
 *
 * Identity is derived, never minted, and it is the idempotency key:
 *
 * - `questionId = 'q-' + sha256(canonicalize({childRunId, requestKey}))` — one
 *   asking run and one caller-derived request key address one question, so a
 *   retry after a crash (or a second delivery attempt) returns the record that
 *   already exists instead of asking the parent twice;
 * - `answerId = 'a-' + sha256(canonicalize({questionId, requestKey}))` — the
 *   same rule one level down. Several answers to one question are legal while
 *   it is open (a parent may answer in two messages, or the first answer may
 *   not resolve anything), so the answer identity is per (question, key) and
 *   not per question.
 *
 * The answer carries one boolean, `resolves`. `false` means the question stays
 * open — an incomplete answer, or one that says the contract has to change — and
 * `true` means the parent declares the question answered. It is deliberately not
 * a classification: the framework does not claim a natural-language answer is
 * correct, does not re-read the contract, and does not grant anything by it.
 *
 * Blocking is derived, not a phase. {@link blockingQuestionsOf} answers "what
 * does this run wait on" from the question facts alone, and an open question
 * requires *both* runs to still be running: when either run settles, its
 * questions stop being open and stop blocking without any cancellation event —
 * a terminal run is never resurrected by a late answer, and no derived phase
 * has to be kept in sync with a stored one.
 *
 * The store's reducer is the gate (see `service/state.ts`): it re-derives the
 * id, checks both runs, the envelope and the citing Session, and refuses a
 * payload that disagrees with what the store holds. The helpers here are pure
 * reads over a {@link TaskSnapshot} — no store, no writes, no effects — so a
 * runtime, a projection and a test all see the same answer.
 *
 * What is *not* here, and does not belong here: delivery. Flushing the cited
 * `tool/call`, putting the message into the target Session's inbox, retrying
 * after a restart and reporting `delivered` are agent-runtime's (A4's second
 * sub-goal); the write gate and the settlement that consume the blocking
 * derivation are task-runtime's. This module owns the fact and the derivation
 * the others read.
 * @module @dangosys/dsh-singularity-task/question
 */

import { canonicalize, sha256Hex } from './contract.ts'
import type { RunId, TaskSnapshot } from './types.ts'

/**
 * A citation into the Session that sent a question or an answer: which Session,
 * and which seq in its log. The event at that seq is the sender's own
 * `tool/call` — the body the model wrote — so the citation is checkable by
 * whoever holds the Session, and a record can never point at a body that was
 * never sent.
 *
 * The `sessionId` is the sending run's own Session (the child run's for a
 * question, the parent run's for an answer), which the reducer enforces: a
 * reference into some other Session would make the citation unusable for
 * recovery and could smuggle text from a conversation this store never saw.
 */
export interface QuestionMessageRef {
  /** The sending run's Session — the Session the cited `tool/call` event lives in. */
  sessionId: string
  /** The seq of that `tool/call` event in the sending Session's log. */
  seq: number
}

/**
 * What a caller states when asking (the payload of `QuestionAsked`, minus what
 * the store derives and stamps): which run asks, the key that makes the request
 * stable, the content digest of the question, the citation of the body, the
 * message identity the delivery layer will use, and whether the answer blocks
 * the asking run.
 *
 * The parent is deliberately absent: it is the asking task's direct parent, and
 * a caller that could name a recipient could ask the wrong node. The store
 * resolves the parent task, and its current run, from the child run alone.
 */
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

/**
 * What a caller states when answering (the payload of `QuestionAnswered`, minus
 * what the store derives and stamps). The answering run is named explicitly and
 * must be the run the question was asked of — a question is addressed to one
 * run, and an answer from a restarted or unrelated run is not an answer to it.
 */
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

/**
 * One stored question: the ask as it was written, plus the id it derives from,
 * the parent run it was addressed to, the time the store recorded it, and the
 * answers that have arrived.
 *
 * `answers` is absent until one is recorded (an answer is its own event, never
 * a rewrite of the question), and its order is the order the store applied
 * them — a reader asking "was this resolved" reads the list, because the
 * resolution *is* an answer's `resolves` declaration and is never duplicated
 * into a flag of its own.
 */
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

/**
 * The questions a snapshot holds, indexed by the one question a reader asks
 * ("what does this run wait on?" is a filter, but "what was this id?" is not):
 * every question in ask order, and by id.
 *
 * The request-key view a proposal index carries is deliberately missing here:
 * a question's key is already inside its id derivation (the asking run and the
 * key are what the id covers), so an id lookup *is* the by-key lookup and a
 * second index could only disagree with it. Answers are not indexed at all —
 * they live under the question they answer.
 */
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

/**
 * The identity a question id is derived from. Exactly these two fields: the
 * asking run keeps two tasks' identical keys apart, and the key keeps two
 * questions of one run apart, so a retry addresses the question it means.
 */
export interface QuestionIdentity {
  childRunId: RunId
  requestKey: string
}

/**
 * The identity an answer id is derived from: the question and the answering
 * caller's key. The question already covers its asking run and its own key.
 */
export interface QuestionAnswerIdentity {
  questionId: string
  requestKey: string
}

/** The `q-` prefix every question id carries, so an id is recognizable wherever it is printed. */
const QUESTION_ID_PREFIX = 'q-'

/** The `a-` prefix every answer id carries. */
const ANSWER_ID_PREFIX = 'a-'

/**
 * The question id one (run, key) pair gets: `q-` plus SHA-256 over
 * {@link canonicalize} of {@link QuestionIdentity}. One implementation, used by
 * every writer and by the idempotency lookup, so "the question this caller
 * asked before the restart" and "the question in the store" cannot be two
 * addresses for one fact. Nothing else is in the digest — the parent run, the
 * body, the blocking flag and the time are recorded *beside* it, and a retry
 * that changes one of them is a conflict the caller hears about, not a second
 * question.
 */
export function questionIdOf(identity: QuestionIdentity): string {
  return `${QUESTION_ID_PREFIX}${sha256Hex(canonicalize(identity))}`
}

/**
 * The answer id one (question, key) pair gets: `a-` plus SHA-256 over
 * {@link canonicalize} of {@link QuestionAnswerIdentity}. Same rule and same
 * reason as {@link questionIdOf}: a repeated answer is answered from the store,
 * and a different answer to the same question is a different key — never a
 * second write under one id.
 */
export function answerIdOf(identity: QuestionAnswerIdentity): string {
  return `${ANSWER_ID_PREFIX}${sha256Hex(canonicalize(identity))}`
}

/**
 * The question one id names, or `undefined` when the store holds none. A
 * snapshot without a question index is refused rather than read as empty: a
 * snapshot built by this build's reducer always carries the index (empty
 * members included), so an absent one means "this reader cannot see questions",
 * and answering "the store holds none" from it would be a lie a caller could
 * act on.
 */
export function questionOf(snapshot: TaskSnapshot, questionId: string): QuestionRecord | undefined {
  return questionIndex(snapshot).byId[questionId]
}

/**
 * The questions one run asked that are still open, in ask order. Open means
 * both halves: no answer has resolved it, and both runs are still running —
 * the parent has to be able to answer, and a settled run is never blocked by
 * anything again. A question whose parent run settled stays on record as an
 * unanswered question; it simply stops being open, which is how terminal
 * cancellation takes effect without a cancellation event.
 */
export function openQuestionsOf(snapshot: TaskSnapshot, childRunId: RunId): QuestionRecord[] {
  return questionIndex(snapshot).all.filter(question => question.childRunId === childRunId && isOpen(snapshot, question))
}

/**
 * The open questions whose answers block the asking run — the derivation the
 * write gate and the display read. `blocking: false` is a real question that is
 * expected to be delivered and answered; it just never stops the run.
 */
export function blockingQuestionsOf(snapshot: TaskSnapshot, childRunId: RunId): QuestionRecord[] {
  return openQuestionsOf(snapshot, childRunId).filter(question => question.blocking)
}

/**
 * The questions one parent run has been asked and has not resolved, in ask
 * order — the parent-side pending list (§7.3: an unanswered question and an
 * unread answer both keep their reference until the model has actually seen
 * them). A question whose parent run settled is not here: nobody can answer it
 * any more, and the asking run derives its own release from the same rule.
 */
export function questionsAwaitingAnswerOf(snapshot: TaskSnapshot, parentRunId: RunId): QuestionRecord[] {
  return questionIndex(snapshot).all.filter(question => question.parentRunId === parentRunId && isOpen(snapshot, question))
}

/** The snapshot's question index, or a refusal: an absent index is "cannot see", never "holds none" (see {@link questionOf}). */
function questionIndex(snapshot: TaskSnapshot): TaskQuestionIndex {
  const index = snapshot.questions
  if (index === undefined) throw new Error('task: snapshot carries no question index')
  return index
}

/**
 * Whether one stored question still blocks anything: unresolved, and both runs
 * still running. `running` is the only non-terminal run status this build
 * writes — `blocked`, `verified`, `failed` and `cancelled` are all settled
 * outcomes a run never leaves — so this one test covers "the child still needs
 * to know" and "the parent can still answer".
 */
function isOpen(snapshot: TaskSnapshot, question: QuestionRecord): boolean {
  if (question.answers?.some(answer => answer.resolves) === true) return false
  return isRunning(snapshot, question.childRunId) && isRunning(snapshot, question.parentRunId)
}

function isRunning(snapshot: TaskSnapshot, runId: RunId): boolean {
  return snapshot.runs.some(run => run.runId === runId && run.status === 'running')
}
