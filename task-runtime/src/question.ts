/**
 * Parent/child question coordination (A4 §F.1): turning one
 * `task_ask_parent`/`task_answer` call into the effects the protocol fixes, in
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
import { message } from './helpers.ts'

/** What one `task_ask_parent` call claims about itself (A4 §F.1): the call it is, and the key it asks under. */
export interface ParentAskCall {
  /**
   * The registration id of the calling tool call. It names the `tool/call` event
   * the body must come from, in the caller's own Session — an id the caller
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
 */
interface QuestionDelivery {
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
type PendingQuestionMessage =
  | (PendingMessageBase & { readonly kind: 'question' })
  | (PendingMessageBase & { readonly kind: 'answer'; readonly answerId: string })

/** What one store's pending question messages are, and which facts cannot be addressed from the snapshot at all. */
interface PendingQuestionMessages {
  readonly messages: readonly PendingQuestionMessage[]
  readonly refused: readonly QuestionReconcileReport[]
}

/**
 * The services one question coordination reaches, narrowed to what it calls: the
 * store's own entries (never the whole service), the caller's Session log, and
 */
export interface QuestionCoordinationDeps {
  /** The Task store: the facts, their one writer, and the snapshot every derivation reads. */
  readonly task: {
    snapshotIn(storeId: string): Promise<TaskSnapshot>
    askParentQuestionIn(
      storeId: string,
      ask: QuestionAsk,
      actor: string,
    ): Promise<{ question: QuestionRecord; created: boolean }>
    answerParentQuestionIn(
      storeId: string,
      answer: QuestionAnswer,
      actor: string,
    ): Promise<{ answer: QuestionAnswerRecord; created: boolean }>
  }
  /** The caller's own Session, to locate the `tool/call` this call cites (and to read it back before deciding anything). */
  readonly sessionQuery: {
    readSession(sessionId: SessionId): Promise<SessionOwnLog>
  }
  /** agent-runtime's handle: the flushed body read-back, the relay, and the recovery reconcile. */
  readonly messages: {
    readToolCallBody(ref: ToolCallRef): Promise<ToolCallBody>
    ensureAgentMessageDelivered(
      intent: AgentMessageIntent,
    ): Promise<{ messageId: string; status: MessageDeliveryStatus }>
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

/**
 * The `m-` identity one question's message carries: derived from the question id,
 * never minted. A retry — in this process or after a restart — states the same
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
    throw new Error(
      `task-runtime: ${where} requires a non-empty "${field}" in its own arguments; the call carries ${JSON.stringify(value)}`,
    )
  }
  return value
}

/** One non-empty string the *caller* claims; a caller that cannot state its own identity is refused before anything is read. */
function claimedString(value: unknown, field: string, toolName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `task-runtime: ${toolName} needs a non-empty "${field}" from its caller; it received ${JSON.stringify(value)}`,
    )
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
 * The Session comes from the caller's identity (its run binding), never from the
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
    throw new Error(
      `task-runtime: ${toolName} could not read back the body of its own call "${callId}" (${message(error)})`,
      { cause: error },
    )
  }
  if (body.name !== toolName) {
    throw new Error(
      `task-runtime: call "${callId}" in session "${callerSessionId}" is "${body.name}", not "${toolName}"; the cited body is the one that was sent`,
    )
  }
  return { ...body, ref }
}

/** The body one ask cites, read back from the caller's own Session and checked against the claim the call makes. */
async function checkAskBody(
  deps: QuestionCoordinationDeps,
  caller: QuestionCaller,
  request: ParentAskCall,
): Promise<CheckedAsk> {
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
  return {
    ref: body.ref,
    digest: sha256Hex(body.arguments),
    requestKey: actualKey,
    question: requiredString(args, 'question', 'task_ask_parent'),
    blocking,
  }
}

/** The body one answer cites, read back from the answering Session and checked against the claim the call makes. */
async function checkAnswerBody(
  deps: QuestionCoordinationDeps,
  caller: QuestionCaller,
  request: ParentAnswerCall,
): Promise<CheckedAnswer> {
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
    throw new Error(
      `task-runtime: task_answer requires a boolean "resolves" in its own arguments; the cited call "${request.callId}" carries none`,
    )
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
 */
async function recordedText(
  deps: QuestionCoordinationDeps,
  ref: QuestionMessageRef,
  field: string,
  where: string,
): Promise<string> {
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
 */
function runOf(snapshot: TaskSnapshot, runId: RunId, where: string): TaskSnapshot['runs'][number] {
  const run = snapshot.runs.find(candidate => candidate.runId === runId)
  if (run === undefined)
    throw new Error(`task-runtime: ${where} names run "${runId}", which the store's snapshot does not hold`)
  return run
}

/**
 * Ask one's direct parent (A4 §F.1): the `task_ask_parent` entry's whole effect.
 * Read the body → commit the intent → recompute the block → deliver under the
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
 * The answering run is the caller's own — the store refuses an answer from any
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
 */
export function pendingQuestionMessages(snapshot: TaskSnapshot): PendingQuestionMessages {
  const index = snapshot.questions
  if (index === undefined) {
    throw new Error(
      "task-runtime: this store's snapshot carries no question index, so its pending question messages cannot be read",
    )
  }
  const open = new Set<string>()
  for (const run of snapshot.runs)
    for (const question of openQuestionsOf(snapshot, run.runId)) open.add(question.questionId)
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
        reason:
          'the store holds the question without both of its runs, so neither the ask nor its answers can be addressed',
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
 * Reconcile the deliveries one store's question facts still owe (§F.1's crash
 * recovery): read each pending body from its *recorded* citation, then hand the
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
        text:
          pendingMessage.kind === 'question'
            ? questionMessageText(
                pendingMessage.questionId,
                await recordedText(deps, pendingMessage.ref, 'question', 'the question'),
              )
            : answerMessageText(
                pendingMessage.answerId,
                pendingMessage.questionId,
                await recordedText(deps, pendingMessage.ref, 'answer', 'the answer'),
              ),
      })
    } catch (error) {
      subjects.pop()
      unreadable.set(pendingMessage.messageId, {
        subject,
        messageId: pendingMessage.messageId,
        status: 'refused',
        reason: message(error),
      })
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
  return [
    ...pending.refused,
    ...pending.messages.flatMap(pendingMessage => {
      const record = reported.get(pendingMessage.messageId) ?? unreadable.get(pendingMessage.messageId)
      return record === undefined ? [] : [record]
    }),
  ]
}

/**
 * Recompute the question block of every run that asked the run just settled —
 * the *fourth* moment the facts behind a block can move, and the one that has no
 */
export function releaseAskingSessions(gate: ExecutionGate, snapshot: TaskSnapshot, settledRunId: RunId): void {
  const index = snapshot.questions
  /**
   * A snapshot without a question index cannot answer "what asked this run", and
   * a settlement must not fail on that: the store's own facts are unchanged, and
   */
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
    /**
     * Only a changed value is worth a decision: the gate's token is what drops a
     * store-derived value read concurrently, and re-pushing the state a session
     */
    if (gate.questionsBlocked(sessionId) !== blocked) gate.setQuestionsBlocked(sessionId, blocked)
  }
}

/**
 * Push the question block every run in one snapshot implies onto the gate, under
 * the gate's own token rule — the recovery pass's half of §F.1's "restart from
 */
export function applyStoreQuestionBlocking(
  gate: ExecutionGate,
  snapshot: TaskSnapshot,
  tokenOf: (sessionId: string) => number,
): void {
  for (const run of snapshot.runs) {
    gate.applyStoreQuestionsBlocked(
      run.sessionId,
      blockingQuestionsOf(snapshot, run.runId).length > 0,
      tokenOf(run.sessionId),
    )
  }
}

/**
 * Whether one run still owes or waits for coordination: no unresolved blocking
 * question of its own, and no question of a child's it has not answered. The
 */
export function pendingCoordinationOf(snapshot: TaskSnapshot, runId: RunId): readonly QuestionRecord[] {
  return [...openQuestionsOf(snapshot, runId), ...questionsAwaitingAnswerOf(snapshot, runId)]
}
