/**
 * Parent/child question coordination (A4 §F.1): turning one
 * `task_ask_parent`/`task_answer` call into the effects the protocol fixes, in
 * the one order it fixes them.
 *
 * The protocol has three owners and this module is the seam between them. The
 * **Task store** owns the fact — which run asks, which run is asked, the
 * citation into the sender's Session, the blocking declaration, and the answer
 * that releases it. **agent-runtime** owns the message — reading the cited
 * `tool/call` back after a flush, and relaying the recorded `messageId` into the
 * target Session's inbox. **The runtime** (this module, for the execution side)
 * owns the *effects* of those facts: the write gate's block
 * ({@link ExecutionGate.setQuestionsBlocked}) and the delivery attempts that
 * follow each commit.
 *
 * The order is the contract's, and each step exists because skipping it produces
 * a specific lie:
 *
 * 1. **The body is read back from the caller's own Session, before anything is
 *    written.** The text of a question or an answer is what the model actually
 *    produced — a `tool/call` event in the session that made the call — so the
 *    runtime never takes the caller's word for it. The call's arguments are
 *    checked against the claim the caller makes (its name, its request key, the
 *    question id and `resolves` for an answer), a mismatch is refused by name,
 *    and this whole step runs *before* the store is touched, so a forged or
 *    unreadable source leaves no task event and no message behind. The digest
 *    recorded in the store is `sha256Hex` over the arguments text exactly as the
 *    Session holds it: the content identity is the bytes the sender wrote, not a
 *    re-encoding of them.
 * 2. **The intent is committed atomically by the store.** The store derives the
 *    question id from (run, request key) and refuses a retry whose content
 *    disagrees with the record it already holds, so "the question I asked before
 *    the crash" and "the question in the store" cannot be two facts.
 * 3. **The blocking state is recomputed from the store and pushed onto the
 *    gate.** Recomputing (not toggling) is what makes two blocking questions
 *    survive one answer: the session is blocked while *any* of them is
 *    unresolved. The gate never blocks on anything else and never opens
 *    anything: `waiting_children` stays `waiting_children`.
 * 4. **The message is delivered under the *recorded* identity.** The text comes
 *    from the citation the record holds (not from the call in hand), and the
 *    `messageId` is derived from the question/answer id, so a retry after a
 *    crash hands the target Session the same identity instead of a second
 *    message. A target that is not live is `unavailable` with zero side effects:
 *    the intent is durable, the record is returned, and the recovery pass
 *    ({@link reconcileQuestionDeliveries}) is what tries again — no substitute
 *    parent is ever invented.
 *
 * What this module deliberately does **not** own: the question facts and their
 * reduction (the task package), the message representation and the DSH relay
 * (agent-runtime), and the run settlement a parent owes once its last
 * coordination item closes (the runtime's own drivers). It also keeps no second
 * index of what is waiting: every answer here is derived from the store's own
 * snapshot, and there is deliberately no consumed ledger — a message the model
 * may not have read is not a message the framework may forget.
 * @module @dangosys/dsh-singularity-task-runtime/question
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import {
  answerIdOf,
  blockingQuestionsOf,
  openQuestionsOf,
  questionIdOf,
  questionOf,
  questionsAwaitingAnswerOf,
  sha256Hex,
} from '@dangosys/dsh-singularity-task'
import type {
  QuestionAnswer,
  QuestionAnswerRecord,
  QuestionAsk,
  QuestionMessageRef,
  QuestionRecord,
  RunId,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { answerMessageText, questionMessageText, toolCallRefIn } from '@dangosys/dsh-singularity-agent-runtime'
import type {
  AgentMessageIntent,
  MessageDeliveryReport,
  MessageDeliveryStatus,
  SessionOwnLog,
  ToolCallBody,
  ToolCallRef,
} from '@dangosys/dsh-singularity-agent-runtime'
import type { ExecutionGate } from './gate.ts'

/** What one `task_ask_parent` call claims about itself (A4 §F.1): the call it is, and the key it asks under. */
export interface ParentAskCall {
  /**
   * The registration id of the calling tool call. It names the `tool/call` event
   * the body must come from, in the caller's own Session — an id the caller
   * cannot forge into somebody else's Session, because the Session is resolved
   * from the caller's run binding and never from this field.
   */
  readonly callId: string
  /** The caller's stable request key for this question; a retry repeats it. */
  readonly requestKey: string
  /** Whether the answer blocks the asking run. Absent means the contract's default (`true`), taken from the call's own arguments. */
  readonly blocking?: boolean
}

/** What one `task_answer` call claims about itself. */
export interface ParentAnswerCall {
  /** The registration id of the calling tool call — the answering Session's own `tool/call`. */
  readonly callId: string
  /** The question being answered; must be the one the cited call names. */
  readonly questionId: string
  /** The caller's stable request key for this answer. */
  readonly requestKey: string
  /** The parent's declaration: `true` answers the question, `false` keeps it open. Never a classification. */
  readonly resolves: boolean
}

/** Who is calling: the live session, the run binding that identifies it, and the actor its writes are attributed to. */
export interface QuestionCaller {
  /** The caller's own Session — where the cited body must live, and (for an ask) the session the question is asked from. */
  readonly sessionId: string
  /** The store the caller's run belongs to. */
  readonly storeId: string
  /** The run the caller is bound to: the asking run for an ask, the answering run for an answer. */
  readonly runId: RunId
  /** The attribution every event of this call carries (the caller's session id, as elsewhere in the runtime). */
  readonly actor: string
}

/**
 * One delivery attempt as the entry point reports it: the identity the store
 * recorded, and what the target Session could witness. `refused` is this
 * module's own name for "the attempt could not be decided at all" — the body
 * could not be read back from the *recorded* citation, or the delivery layer
 * raised a refusal — and it is reported rather than thrown because the intent is
 * durable by then: the caller keeps the record, and recovery retries.
 */
export interface QuestionDelivery {
  readonly messageId: string
  readonly status: MessageDeliveryStatus | 'refused'
  /** Present only with `refused`: why no delivery could be settled. */
  readonly reason?: string
}

/** What one ask settled as: the stored record, whether this call wrote it, and what the delivery attempt settled as. */
export interface AskedQuestionOutcome {
  readonly question: QuestionRecord
  readonly created: boolean
  readonly delivery: QuestionDelivery
}

/** What one answer settled as: the stored record, whether this call wrote it, and what the delivery attempt settled as. */
export interface AnsweredQuestionOutcome {
  readonly answer: QuestionAnswerRecord
  readonly created: boolean
  readonly delivery: QuestionDelivery
}

/** One record a reconciliation pass addressed: which fact it belongs to, and what the attempt settled as. */
export interface QuestionReconcileReport {
  /** Which question or answer the record is about, in the store's own ids (`question "q-…"`, `answer "a-…" for question "q-…"`). */
  readonly subject: string
  readonly messageId: string
  readonly status: MessageDeliveryStatus | 'refused'
  readonly reason?: string
}

/** Where one owed message comes from and where it goes, before its body is read back from the citation. */
interface PendingMessageBase {
  /** Which fact the message belongs to, in the store's own ids. */
  readonly subject: string
  readonly questionId: string
  readonly messageId: string
  /** The sender's own citation into its Session: where the body is. */
  readonly ref: QuestionMessageRef
  readonly senderSessionId: string
  readonly targetSessionId: string
}

/** One message a store's question facts still owe: an open question's ask, or an answer to a run that may not have read it. */
export type PendingQuestionMessage =
  | (PendingMessageBase & { readonly kind: 'question' })
  | (PendingMessageBase & { readonly kind: 'answer'; readonly answerId: string })

/** What one store's pending question messages are, and which facts cannot be addressed from the snapshot at all. */
export interface PendingQuestionMessages {
  readonly messages: readonly PendingQuestionMessage[]
  readonly refused: readonly QuestionReconcileReport[]
}

/**
 * The services one question coordination reaches, narrowed to what it calls: the
 * store's own entries (never the whole service), the caller's Session log, and
 * agent-runtime's delivery handle. Nothing here resolves another service through
 * this module, and a caller can hand a test double for any of them.
 */
export interface QuestionCoordinationDeps {
  /** The Task store: the facts, their one writer, and the snapshot every derivation reads. */
  readonly task: {
    snapshotIn(storeId: string): Promise<TaskSnapshot>
    askParentQuestionIn(storeId: string, ask: QuestionAsk, actor: string): Promise<{ question: QuestionRecord; created: boolean }>
    answerParentQuestionIn(storeId: string, answer: QuestionAnswer, actor: string): Promise<{ answer: QuestionAnswerRecord; created: boolean }>
  }
  /** The caller's own Session, to locate the `tool/call` this call cites (and to read it back before deciding anything). */
  readonly sessionQuery: {
    readSession(sessionId: SessionId): Promise<SessionOwnLog>
  }
  /** agent-runtime's handle: the flushed body read-back, the relay, and the recovery reconcile. */
  readonly messages: {
    readToolCallBody(ref: ToolCallRef): Promise<ToolCallBody>
    ensureAgentMessageDelivered(intent: AgentMessageIntent): Promise<{ messageId: string; status: MessageDeliveryStatus }>
    reconcileAgentMessageDeliveries(intents: readonly AgentMessageIntent[]): Promise<MessageDeliveryReport[]>
  }
  /** The execution gate whose *blocking* state these facts decide (A4 §7.2). */
  readonly gate: ExecutionGate
}

/** The checked body of one ask: the citation and digest the store records, plus the fields the cited arguments must carry. */
interface CheckedAsk {
  readonly ref: QuestionMessageRef
  readonly digest: string
  readonly requestKey: string
  readonly question: string
  readonly blocking: boolean
}

/** The checked body of one answer: the citation and digest the store records, plus the fields the cited arguments must carry. */
interface CheckedAnswer {
  readonly ref: QuestionMessageRef
  readonly digest: string
  readonly questionId: string
  readonly requestKey: string
  readonly answer: string
  readonly resolves: boolean
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `m-` identity one question's message carries: derived from the question id,
 * never minted. A retry — in this process or after a restart — states the same
 * identity, which is what lets a target's own fold answer "this one is already
 * here" instead of the framework keeping a ledger of what it sent.
 */
export function questionMessageIdOf(questionId: string): string {
  return `m-${questionId}`
}

/** The `m-` identity one answer's message carries, derived from the answer id for the same reason ({@link questionMessageIdOf}). */
export function answerMessageIdOf(answerId: string): string {
  return `m-${answerId}`
}

/**
 * The arguments object one cited `tool/call` must hold: a JSON object, refused by
 * name when it is not. Exported for the same reason this module's other pure
 * steps are: the refusal rules are part of the contract, and a unit test should
 * be able to drive them without a store.
 */
export function parseCallArguments(body: ToolCallBody): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.arguments)
  } catch (error) {
    throw new Error(
      `task-runtime: the arguments of the cited "${body.name}" call are not JSON (${message(error)}); ` +
      'a body that cannot be parsed is not a citation',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`task-runtime: the arguments of the cited "${body.name}" call are not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** One non-empty string field of a cited call's arguments, refused by name when it is absent or blank. */
function requiredString(args: Record<string, unknown>, field: string, where: string): string {
  const value = args[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`task-runtime: ${where} requires a non-empty "${field}" in its own arguments; the call carries ${JSON.stringify(value)}`)
  }
  return value
}

/** One non-empty string the *caller* claims; a caller that cannot state its own identity is refused before anything is read. */
function claimedString(value: unknown, field: string, toolName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`task-runtime: ${toolName} needs a non-empty "${field}" from its caller; it received ${JSON.stringify(value)}`)
  }
  return value
}

/** How one boolean argument reads: absent takes `absent`, a non-boolean is refused (never coerced). */
function booleanArgument(args: Record<string, unknown>, field: string, absent: boolean, where: string): boolean {
  const value = args[field]
  if (value === undefined) return absent
  if (typeof value !== 'boolean') {
    throw new Error(`task-runtime: ${where} carries "${field}": ${JSON.stringify(value)}, which is not a boolean`)
  }
  return value
}

/**
 * Locate and read back the caller's *own* `tool/call`, by registration id.
 *
 * The Session comes from the caller's identity (its run binding), never from the
 * request: an id can only ever name an event of the calling session. The read
 * goes through agent-runtime's `readToolCallBody`, which flushes the live
 * Session first — the citation must be durable before a store may record it —
 * and refuses by name when the event is missing, unreadable, or not a tool call.
 */
async function readOwnCall(
  deps: QuestionCoordinationDeps,
  callerSessionId: string,
  callId: string,
  toolName: string,
): Promise<ToolCallBody & { ref: ToolCallRef }> {
  if (callId.length === 0) {
    throw new Error(`task-runtime: ${toolName} needs the registration id of its own call to cite its body`)
  }
  let log: SessionOwnLog
  try {
    log = await deps.sessionQuery.readSession(SessionId(callerSessionId))
  } catch (error) {
    throw new Error(
      `task-runtime: ${toolName} cannot read session "${callerSessionId}" to locate its own call "${callId}": ${message(error)}`,
      { cause: error },
    )
  }
  const ref = toolCallRefIn(log, callId)
  if (ref === undefined) {
    throw new Error(
      `task-runtime: session "${callerSessionId}" holds no tool/call "${callId}"; ${toolName} cites the call it is answering for, ` +
      "and a caller cannot cite somebody else's call or a call that was never made",
    )
  }
  let body: ToolCallBody
  try {
    body = await deps.messages.readToolCallBody(ref)
  } catch (error) {
    throw new Error(`task-runtime: ${toolName} could not read back the body of its own call "${callId}" (${message(error)})`, { cause: error })
  }
  if (body.name !== toolName) {
    throw new Error(
      `task-runtime: call "${callId}" in session "${callerSessionId}" is "${body.name}", not "${toolName}"; the cited body is the one that was sent`,
    )
  }
  return { ...body, ref }
}

/** The body one ask cites, read back from the caller's own Session and checked against the claim the call makes. */
async function checkAskBody(deps: QuestionCoordinationDeps, caller: QuestionCaller, request: ParentAskCall): Promise<CheckedAsk> {
  const body = await readOwnCall(deps, caller.sessionId, request.callId, 'task_ask_parent')
  const args = parseCallArguments(body)
  const claimedKey = claimedString(request.requestKey, 'requestKey', 'task_ask_parent')
  const actualKey = requiredString(args, 'requestKey', 'task_ask_parent')
  if (actualKey !== claimedKey) {
    throw new Error(
      `task-runtime: task_ask_parent claims request key "${claimedKey}", but the cited call "${request.callId}" asked under "${actualKey}"; ` +
      'the arguments the sender wrote are the only request key the store may record',
    )
  }
  const blocking = booleanArgument(args, 'blocking', true, 'task_ask_parent')
  if (request.blocking !== undefined && request.blocking !== blocking) {
    throw new Error(
      `task-runtime: task_ask_parent claims blocking=${String(request.blocking)}, but the cited call "${request.callId}" declared ${String(blocking)}; ` +
      'a caller cannot record a blocking declaration its own message does not carry',
    )
  }
  return { ref: body.ref, digest: sha256Hex(body.arguments), requestKey: actualKey, question: requiredString(args, 'question', 'task_ask_parent'), blocking }
}

/** The body one answer cites, read back from the answering Session and checked against the claim the call makes. */
async function checkAnswerBody(deps: QuestionCoordinationDeps, caller: QuestionCaller, request: ParentAnswerCall): Promise<CheckedAnswer> {
  const body = await readOwnCall(deps, caller.sessionId, request.callId, 'task_answer')
  const args = parseCallArguments(body)
  const claimedQuestion = claimedString(request.questionId, 'questionId', 'task_answer')
  const actualQuestion = requiredString(args, 'questionId', 'task_answer')
  if (actualQuestion !== claimedQuestion) {
    throw new Error(
      `task-runtime: task_answer claims question "${claimedQuestion}", but the cited call "${request.callId}" answers "${actualQuestion}"; ` +
      'a call answers the question its own message names',
    )
  }
  const claimedKey = claimedString(request.requestKey, 'requestKey', 'task_answer')
  const actualKey = requiredString(args, 'requestKey', 'task_answer')
  if (actualKey !== claimedKey) {
    throw new Error(
      `task-runtime: task_answer claims request key "${claimedKey}", but the cited call "${request.callId}" answered under "${actualKey}"`,
    )
  }
  if (args.resolves === undefined) {
    throw new Error(`task-runtime: task_answer requires a boolean "resolves" in its own arguments; the cited call "${request.callId}" carries none`)
  }
  const resolves = booleanArgument(args, 'resolves', false, 'task_answer')
  if (request.resolves !== resolves) {
    throw new Error(
      `task-runtime: task_answer claims resolves=${String(request.resolves)}, but the cited call "${request.callId}" declared ${String(resolves)}; ` +
      'an answer releases exactly what its own message declares',
    )
  }
  return {
    ref: body.ref,
    digest: sha256Hex(body.arguments),
    questionId: actualQuestion,
    requestKey: actualKey,
    answer: requiredString(args, 'answer', 'task_answer'),
    resolves,
  }
}

/**
 * Read one *recorded* citation back for the text a message carries. This is the
 * record's own `(session, seq)` — not the call in hand — so a retry delivers
 * exactly the bytes the store's record points at, and a record whose Session can
 * no longer be read is a refusal rather than a made-up body.
 */
async function recordedText(deps: QuestionCoordinationDeps, ref: QuestionMessageRef, field: string, where: string): Promise<string> {
  let body: ToolCallBody
  try {
    body = await deps.messages.readToolCallBody({ sessionId: SessionId(ref.sessionId), seq: ref.seq })
  } catch (error) {
    throw new Error(
      `task-runtime: the recorded body of ${where} could not be read from session "${ref.sessionId}" seq ${ref.seq}: ${message(error)}`,
      { cause: error },
    )
  }
  return requiredString(parseCallArguments(body), field, `the recorded ${where}`)
}

/**
 * Compose and deliver one recorded message, reporting rather than throwing: by
 * this point the store's record is durable, so a delivery that cannot be decided
 * is information for the caller and a retry for the recovery pass — never a
 * reason to fail the call that already recorded the fact.
 */
async function deliverRecorded(
  deps: QuestionCoordinationDeps,
  record: {
    readonly messageId: string
    readonly targetSessionId: string
    readonly senderSessionId: string
    readonly ref: QuestionMessageRef
    readonly field: string
    readonly where: string
    readonly render: (body: string) => string
  },
): Promise<QuestionDelivery> {
  try {
    const intent: AgentMessageIntent = {
      targetSessionId: SessionId(record.targetSessionId),
      senderSessionId: SessionId(record.senderSessionId),
      messageId: record.messageId,
      text: record.render(await recordedText(deps, record.ref, record.field, record.where)),
    }
    const delivery = await deps.messages.ensureAgentMessageDelivered(intent)
    return { messageId: delivery.messageId, status: delivery.status }
  } catch (error) {
    return { messageId: record.messageId, status: 'refused', reason: message(error) }
  }
}

/**
 * The run one id names, or a refusal: every caller here reads a fact whose run
 * the store has already checked, so a missing one is a defect of the snapshot,
 * not a state to carry on from.
 */
function runOf(snapshot: TaskSnapshot, runId: RunId, where: string): TaskSnapshot['runs'][number] {
  const run = snapshot.runs.find(candidate => candidate.runId === runId)
  if (run === undefined) throw new Error(`task-runtime: ${where} names run "${runId}", which the store's snapshot does not hold`)
  return run
}

/**
 * Ask one's direct parent (A4 §F.1): the `task_ask_parent` entry's whole effect.
 *
 * Read the body → commit the intent → recompute the block → deliver under the
 * recorded identity. The parent is never named by the caller: the store resolves
 * the asking task's direct parent and *its* current run, and the delivery goes to
 * that run's Session. A repeated request (same run, same key, same arguments
 * text) returns the record the store already holds, changes no gate state and
 * delivers the same `messageId` — which is `already-present` when the target
 * still holds it.
 */
export async function askParentQuestion(
  deps: QuestionCoordinationDeps,
  caller: QuestionCaller,
  request: ParentAskCall,
): Promise<AskedQuestionOutcome> {
  const checked = await checkAskBody(deps, caller, request)
  const ask: QuestionAsk = {
    childRunId: caller.runId,
    requestKey: checked.requestKey,
    questionDigest: checked.digest,
    questionRef: { sessionId: caller.sessionId, seq: checked.ref.seq },
    messageId: questionMessageIdOf(questionIdOf({ childRunId: caller.runId, requestKey: checked.requestKey })),
    blocking: checked.blocking,
  }
  const stored = await deps.task.askParentQuestionIn(caller.storeId, ask, caller.actor)
  // The block is recomputed from the store *after* the commit: a retry finds the
  // record and the same derivation, and nothing here toggles.
  const snapshot = await deps.task.snapshotIn(caller.storeId)
  deps.gate.setQuestionsBlocked(caller.sessionId, blockingQuestionsOf(snapshot, stored.question.childRunId).length > 0)
  const parentRun = runOf(snapshot, stored.question.parentRunId, `question "${stored.question.questionId}"`)
  const delivery = await deliverRecorded(deps, {
    messageId: stored.question.messageId,
    targetSessionId: parentRun.sessionId,
    senderSessionId: caller.sessionId,
    ref: stored.question.questionRef,
    field: 'question',
    where: 'the question',
    render: written => questionMessageText(stored.question.questionId, written),
  })
  return { question: stored.question, created: stored.created, delivery }
}

/**
 * Answer one child's question (A4 §F.1): the `task_answer` entry's whole effect.
 *
 * The answering run is the caller's own — the store refuses an answer from any
 * other run, including the new run of a restarted task — and the body citation
 * must sit in the answering Session. The message goes to the *asking* run's
 * Session, so `resolves: true` both releases that run's write gate (recomputed
 * from the facts, so a second open question keeps it blocked) and puts the
 * parent's words in front of the model that asked.
 */
export async function answerParentQuestion(
  deps: QuestionCoordinationDeps,
  caller: QuestionCaller,
  request: ParentAnswerCall,
): Promise<AnsweredQuestionOutcome> {
  const checked = await checkAnswerBody(deps, caller, request)
  const answer: QuestionAnswer = {
    questionId: checked.questionId,
    parentRunId: caller.runId,
    requestKey: checked.requestKey,
    answerDigest: checked.digest,
    resolves: checked.resolves,
    answerRef: { sessionId: caller.sessionId, seq: checked.ref.seq },
    messageId: answerMessageIdOf(answerIdOf({ questionId: checked.questionId, requestKey: checked.requestKey })),
  }
  const stored = await deps.task.answerParentQuestionIn(caller.storeId, answer, caller.actor)
  const snapshot = await deps.task.snapshotIn(caller.storeId)
  const question = questionOf(snapshot, stored.answer.questionId)
  if (question === undefined) {
    throw new Error(
      `task-runtime: answer "${stored.answer.answerId}" was recorded, but its question is not in the store's snapshot; ` +
      'the block and the delivery cannot be decided from a fact the snapshot does not hold',
    )
  }
  const childRun = runOf(snapshot, question.childRunId, `question "${question.questionId}"`)
  if (stored.answer.resolves) {
    deps.gate.setQuestionsBlocked(childRun.sessionId, blockingQuestionsOf(snapshot, question.childRunId).length > 0)
  }
  const delivery = await deliverRecorded(deps, {
    messageId: stored.answer.messageId,
    targetSessionId: childRun.sessionId,
    senderSessionId: caller.sessionId,
    ref: stored.answer.answerRef,
    field: 'answer',
    where: 'the answer',
    render: written => answerMessageText(stored.answer.answerId, stored.answer.questionId, written),
  })
  return { answer: stored.answer, created: stored.created, delivery }
}

/**
 * What one store's question facts still owe a message, derived from its own
 * snapshot and nothing else.
 *
 * Two rules, and both are about what the *facts* can prove rather than about
 * what a process remembers:
 *
 * - every **open** question owes its ask: both runs are running and no answer
 *   has resolved it, so the parent still has to be able to answer it;
 * - every **answer** whose asking run is still running owes its delivery: the
 *   framework has no consumption proof (§F.1 keeps the reference until a real
 *   model step shows it), so even a resolved question's answer is owed to a run
 *   that may never have read it.
 *
 * Nothing else is owed. A question whose asking run settled is audit — its ask
 * and its answers are moot, and re-delivering them would be a message to a run
 * that cannot act on it.
 */
export function pendingQuestionMessages(snapshot: TaskSnapshot): PendingQuestionMessages {
  const index = snapshot.questions
  if (index === undefined) {
    throw new Error("task-runtime: this store's snapshot carries no question index, so its pending question messages cannot be read")
  }
  const open = new Set<string>()
  for (const run of snapshot.runs) for (const question of openQuestionsOf(snapshot, run.runId)) open.add(question.questionId)
  const messages: PendingQuestionMessage[] = []
  const refused: QuestionReconcileReport[] = []
  for (const question of index.all) {
    const subject = `question "${question.questionId}"`
    const childRun = snapshot.runs.find(run => run.runId === question.childRunId)
    const parentRun = snapshot.runs.find(run => run.runId === question.parentRunId)
    if (childRun === undefined || parentRun === undefined) {
      refused.push({
        subject,
        messageId: question.messageId,
        status: 'refused',
        reason: 'the store holds the question without both of its runs, so neither the ask nor its answers can be addressed',
      })
      continue
    }
    if (open.has(question.questionId)) {
      messages.push({
        subject,
        kind: 'question',
        questionId: question.questionId,
        messageId: question.messageId,
        ref: question.questionRef,
        senderSessionId: childRun.sessionId,
        targetSessionId: parentRun.sessionId,
      })
    }
    if (childRun.status !== 'running') continue
    for (const answer of question.answers ?? []) {
      messages.push({
        subject: `answer "${answer.answerId}" for question "${question.questionId}"`,
        kind: 'answer',
        questionId: question.questionId,
        answerId: answer.answerId,
        messageId: answer.messageId,
        ref: answer.answerRef,
        senderSessionId: parentRun.sessionId,
        targetSessionId: childRun.sessionId,
      })
    }
  }
  return { messages, refused }
}

/**
 * The question messages one store still owes **one Session** — the same
 * derivation as {@link pendingQuestionMessages}, narrowed to a target.
 *
 * It exists for the recovery pass's own question (A4 §F.1): an unsubmitted run
 * whose Session is owed a delivery is *not* an abandoned run. The clearest case
 * is an answered question whose answer has not been read — the asking run's
 * block is already gone (the answer resolved it), so the blocking derivation
 * cannot see the wait, while the store still owes that run the answer it waited
 * for. Cancelling it there would throw away exactly what the exchange produced.
 */
export function owedQuestionMessagesTo(snapshot: TaskSnapshot, sessionId: string): PendingQuestionMessage[] {
  return pendingQuestionMessages(snapshot).messages.filter(message => message.targetSessionId === sessionId)
}

/**
 * Reconcile the deliveries one store's question facts still owe (§F.1's crash
 * recovery): read each pending body from its *recorded* citation, then hand the
 * composed intents to agent-runtime's reconcile — which delivers only what the
 * target Session's own fold says is missing, so a second pass over the same
 * record adds nothing.
 *
 * A recorded body that can no longer be read is reported per record rather than
 * failing the pass: the facts are still the facts, the next activation is the
 * retry, and one unreadable Session must not hide the deliveries that could be
 * made. A target that is not live comes back `unavailable` — zero side effects,
 * no substitute parent, and the same retry rule.
 */
export async function reconcileQuestionDeliveries(
  deps: QuestionCoordinationDeps,
  storeId: string,
): Promise<QuestionReconcileReport[]> {
  const snapshot = await deps.task.snapshotIn(storeId)
  const pending = pendingQuestionMessages(snapshot)
  const composed: AgentMessageIntent[] = []
  const subjects: string[] = []
  const unreadable = new Map<string, QuestionReconcileReport>()
  for (const pendingMessage of pending.messages) {
    const subject = pendingMessage.subject
    try {
      subjects.push(subject)
      composed.push({
        targetSessionId: SessionId(pendingMessage.targetSessionId),
        senderSessionId: SessionId(pendingMessage.senderSessionId),
        messageId: pendingMessage.messageId,
        text: pendingMessage.kind === 'question'
          ? questionMessageText(pendingMessage.questionId, await recordedText(deps, pendingMessage.ref, 'question', 'the question'))
          : answerMessageText(pendingMessage.answerId, pendingMessage.questionId, await recordedText(deps, pendingMessage.ref, 'answer', 'the answer')),
      })
    } catch (error) {
      subjects.pop()
      unreadable.set(pendingMessage.messageId, { subject, messageId: pendingMessage.messageId, status: 'refused', reason: message(error) })
    }
  }
  const settled = composed.length === 0 ? [] : await deps.messages.reconcileAgentMessageDeliveries(composed)
  const reported = new Map<string, QuestionReconcileReport>()
  settled.forEach((report, index) => {
    reported.set(report.messageId, {
      subject: subjects[index] as string,
      messageId: report.messageId,
      status: report.status,
      ...(report.reason === undefined ? {} : { reason: report.reason }),
    })
  })
  // The report is the facts' own order — the questions in ask order, each ask
  // before its answers — because it is what a recovery read tells an operator.
  return [...pending.refused, ...pending.messages.flatMap(pendingMessage => {
    const record = reported.get(pendingMessage.messageId) ?? unreadable.get(pendingMessage.messageId)
    return record === undefined ? [] : [record]
  })]
}

/**
 * Recompute the question block of every run that asked the run just settled —
 * the *fourth* moment the facts behind a block can move, and the one that has no
 * event of its own.
 *
 * An open question requires both runs to still be running ({@link
 * blockingQuestionsOf}), so the moment the *addressee* settles, every question
 * addressed to it stops being open: the asking run is no longer waiting on
 * anything, and nothing about it may be refused for a wait that no longer
 * exists. No `QuestionAnswered` was written and no phase moved, so the three
 * push sites that recompute a block (the ask, the resolving answer, recovery)
 * never run — without this step a run whose parent settled first would keep a
 * refusal that only its own wall time could end.
 *
 * Everything pushed here is derived from the snapshot the caller read *after*
 * the settlement, and the asking sessions are found from the store's own
 * questions (an answer carries no session; the citation does) rather than from
 * anything this process remembers. The asking run's own session is not the
 * subject — a run that settled closes its own gate — and a question whose asking
 * run is no longer running has nothing left to release.
 */
export function releaseAskingSessions(gate: ExecutionGate, snapshot: TaskSnapshot, settledRunId: RunId): void {
  const index = snapshot.questions
  // A snapshot without a question index cannot answer "what asked this run", and
  // a settlement must not fail on that: the store's own facts are unchanged, and
  // the next read that carries the index recomputes the same blocks.
  if (index === undefined) return
  const asking = new Map<string, RunId>()
  for (const question of index.all) {
    if (question.parentRunId !== settledRunId) continue
    const childRun = snapshot.runs.find(run => run.runId === question.childRunId)
    if (childRun === undefined || childRun.status !== 'running') continue
    asking.set(childRun.sessionId, childRun.runId)
  }
  for (const [sessionId, childRunId] of asking) {
    const blocked = blockingQuestionsOf(snapshot, childRunId).length > 0
    // Only a changed value is worth a decision: the gate's token is what drops a
    // store-derived value read concurrently, and re-pushing the state a session
    // already holds would move that token for no fact at all.
    if (gate.questionsBlocked(sessionId) !== blocked) gate.setQuestionsBlocked(sessionId, blocked)
  }
}

/**
 * Push the question block every run in one snapshot implies onto the gate, under
 * the gate's own token rule — the recovery pass's half of §F.1's "restart from
 * the durable facts". The token is the one taken before the snapshot read, so a
 * value that straddled a decision of this process is dropped exactly as a
 * store-derived phase is.
 */
export function applyStoreQuestionBlocking(
  gate: ExecutionGate,
  snapshot: TaskSnapshot,
  tokenOf: (sessionId: string) => number,
): void {
  for (const run of snapshot.runs) {
    gate.applyStoreQuestionsBlocked(run.sessionId, blockingQuestionsOf(snapshot, run.runId).length > 0, tokenOf(run.sessionId))
  }
}

/**
 * Whether one run still owes or waits for coordination: no unresolved blocking
 * question of its own, and no question of a child's it has not answered. The
 * runtime reads this where a run's own next step would otherwise be automatic —
 * the parent's submission once its children are terminal — and the answer is
 * deliberately *derived* from the facts rather than stored: an answered question
 * and an unanswered one are the same list, one answer apart.
 */
export function pendingCoordinationOf(snapshot: TaskSnapshot, runId: RunId): readonly QuestionRecord[] {
  return [...openQuestionsOf(snapshot, runId), ...questionsAwaitingAnswerOf(snapshot, runId)]
}
