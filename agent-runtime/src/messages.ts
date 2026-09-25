/**
 * Delivery of one decided message identity into a target Session's inbox (A4,
 * plan §F.1 — the second half of the parent/child question protocol).
 *
 * The fact is the Task store's: a question or an answer already has an identity
 * (`questionId`/`answerId`) and a durable `messageId` derived from it, and the
 * store committed the intent to deliver that identity to exactly one target
 * Session. This module owns what comes after — putting the message into that
 * Session's inbox, and reporting no more than the Session can witness.
 *
 * Three rules decide the shape:
 *
 * - **The identity is taken, never minted.** `freezeMessage` exists because DSH's
 *   `createMessage`/`createUserMessage` mint a fresh random id; a relayed
 *   question must carry the id the store recorded, or a retry after a restart
 *   would deliver a second message the fold cannot recognize. The source is
 *   `agent-message`/`relay` with the sender's own Session id — never `user`
 *   (that kind is DSH's host-attested human marker, and a delegation credited to
 *   a person would be a lie the transcript keeps) and never `plugin`.
 *
 * - **The fold decides, not the queue.** A pending inbox entry is removed by the
 *   next step's claim *before* the model request is built, and an id that has
 *   been claimed or has reached history is not protected by any dedup: only a
 *   fold over the Session's own durable events can answer "was this identity
 *   already accepted". The fold is DSH's own two-source rule (history
 *   `user/message` plus the `agent/inbox/spliced` replay), taken from
 *   `agent-team/src/session-message.ts` — the experimental package is not a
 *   dependency, only the algorithm is copied, because the durable representation
 *   is DSH's and a second derivation could disagree with it.
 *
 * - **A receipt is a durability claim.** `ctx.sessions.flush` is the only barrier
 *   that says the bytes reached the store (a live Session's appends are batched
 *   behind a 200 ms window), so `delivered` is returned only after the target was
 *   flushed *and* its own log was read back. Nothing here proves the model read
 *   the message: an inbox entry and a claim both do not, and the contract keeps
 *   the pending reference until a real step input shows it. `delivered` is
 *   transport truth, nothing more — and it is not even "still queued": a target
 *   already mid-turn may claim the message while the flush is in flight, which is
 *   why the receipt reads the durable insertion record and not only the current
 *   queue.
 *
 * A target that is not live is `unavailable` with zero side effects: no offline
 * write, no resume, no substitute parent. Resurrecting the target and retrying is
 * the recovery path's job (A4's third sub-goal), and every entry point here is
 * idempotent so that retry is safe.
 * @module @dangosys/dsh-singularity-agent-runtime/messages
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventReadRequest, SessionEventWindow, SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
// The `agent-message` source kind is declared into DSH's `MessageSourceMap` by
// the subagent package (`subagent/src/continuation-messages.ts`); the type-only
// import is what makes this module's relay source the same type DSH defines,
// instead of a local copy that could drift from it.
import type {} from '@deepseek-ai/dsh-subagent'

/**
 * Why one delivery or source read was refused. Every refusal is named: a caller
 * that cannot act on the difference between "not there yet" and "cannot be
 * decided" would retry the wrong thing.
 */
export type MessageRefusalCode =
  /** The cited Session holds no event at the cited seq. */
  | 'source-event-missing'
  /** The cited Session does not exist. */
  | 'source-session-missing'
  /** The cited Session exists but could not be read. */
  | 'source-unreadable'
  /** The cited Session's log has no durability barrier, so its body cannot be witnessed. */
  | 'source-not-durable'
  /** The cited event is not the `tool/call` it is cited as. */
  | 'source-not-tool-call'
  /** The target Session's log could not be read, so whether the message was accepted cannot be decided. */
  | 'target-unreadable'
  /** The target Session has no durability barrier (or is no longer live in this process). */
  | 'target-not-durable'
  /** Delivery was attempted but the identity is not in the target's log afterwards. */
  | 'delivery-unconfirmed'

/** One refused source read or delivery, with the stable name of what went wrong. */
export class MessageDeliveryRefusal extends Error {
  readonly code: MessageRefusalCode

  constructor(code: MessageRefusalCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MessageDeliveryRefusal'
    this.code = code
  }
}

/** Where a message body was written: the sending Session and the seq of its `tool/call`. */
export interface ToolCallRef {
  /** The sending Session — the Session the cited `tool/call` event lives in. */
  readonly sessionId: SessionId
  /** The seq of that event in the sending Session's log. */
  readonly seq: number
}

/** The body at a cited `tool/call`: the tool name and the raw arguments text. */
export interface ToolCallBody {
  /** The tool the model called. */
  readonly name: string
  /** The `arguments` JSON text exactly as the model produced it, unparsed here. */
  readonly arguments: string
}

/**
 * One message the Task store has already decided to deliver: the durable
 * identity, the two Sessions, and the text. Everything about it is a record the
 * store holds, so a retry after a restart states the same delivery.
 */
export interface AgentMessageIntent {
  /** The Session that must receive the message. */
  readonly targetSessionId: SessionId
  /** The Session whose agent authored the body. */
  readonly senderSessionId: SessionId
  /** The durable message identity the Task store recorded. */
  readonly messageId: string
  /** The model-facing body, identity included (see {@link questionMessageText}). */
  readonly text: string
}

/**
 * What one delivery attempt settled as.
 *
 * `delivered` — this call put the identity into the target's log and the target
 * was flushed; `already-present` — the target's log already held the identity,
 * so this call wrote nothing (a retry, or a concurrent attempt that won the
 * race); `unavailable` — no live agent owns the target, nothing was attempted.
 */
export type MessageDeliveryStatus = 'delivered' | 'already-present' | 'unavailable'

/** The settled outcome of one delivery attempt. */
export interface MessageDelivery {
  /** The identity this attempt addressed. */
  readonly messageId: string
  readonly status: MessageDeliveryStatus
}

/** One record of a reconciliation pass: what each intent of the set settled as. */
export interface MessageDeliveryReport {
  /** The identity this record addressed. */
  readonly messageId: string
  /** The settled status, or `refused` when the attempt could not be decided at all. */
  readonly status: MessageDeliveryStatus | 'refused'
  /** Why the attempt was refused; present only with `refused`. */
  readonly reason?: string
}

/**
 * The services a delivery needs, narrowed to what it actually calls: the live
 * agent registry it can wake, the session store whose `flush` is the durability
 * barrier, and the session read path it folds. No service resolves another one
 * through this module, and a caller can hand a test double for any of them.
 */
export interface MessageDeliveryDeps {
  /** Live agents by Session id — the only registry a delivery reaches a target through. */
  readonly agents: { get(id: SessionId): Agent | undefined }
  /** Live sessions: `get` decides whether there is anything to flush, `flush` is the barrier. */
  readonly sessions: {
    get(id: SessionId): Session | undefined
    flush(session: Session): Promise<boolean>
  }
  /** The session read path: exact event reads and live-preferred whole-log folds. */
  readonly sessionQuery: {
    readEvent(request: SessionEventReadRequest): Promise<SessionEventWindow>
    readSession(sessionId: SessionId): Promise<SessionLogSnapshot>
  }
}

/** The message body a question carries into its parent's Session: the stable question identity, then what was asked. */
export function questionMessageText(questionId: string, question: string): string {
  return `[task-question ${questionId}] ${question}`
}

/**
 * The message body an answer carries into the asking Session: both identities,
 * so the receiving model can tell which answer resolves which question without
 * a second lookup, then what the parent answered.
 */
export function answerMessageText(answerId: string, questionId: string, answer: string): string {
  return `[task-answer ${answerId} for ${questionId}] ${answer}`
}

/**
 * Build the identified, frozen relay message one intent delivers. Pure and
 * exported so a caller can inspect the exact representation it is about to
 * write; nothing here reaches the Task store or the Session.
 */
export function relayMessage(intent: AgentMessageIntent): UserMessage {
  return freezeMessage({
    id: MessageId(intent.messageId),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: intent.text }],
    source: {
      kind: 'agent-message' as const,
      form: 'relay' as const,
      senderSessionId: intent.senderSessionId,
    },
  })
}

/**
 * Whether a Session's own event suffix already holds one message identity, in
 * history or still pending in the inbox. `events` must be the Session's own
 * suffix (its fork-inherited prefix belongs to the Session it descends from and
 * is not a delivery to this one).
 *
 * This is the *retry* rule: an identity a claim already removed and history
 * never took is not accepted, because the model never saw it and the recovery
 * path must deliver it again (§F.1: "claim 在 pre-step 前可能已移除").
 */
export function messageAccepted(events: readonly SessionEvent[], messageId: string): boolean {
  return events.some(event => event.type === 'user/message' && event.data.id === messageId)
    || pendingInboxMessages(events).some(message => message.id === messageId)
}

/**
 * Whether the log durably records that this identity entered the Session's
 * inbox — the *receipt* rule, which is wider than {@link messageAccepted} by one
 * case: a claim (or a cancel's clear) removes a pending entry through a splice
 * that carries no identity, so between "claimed" and "in history" the identity
 * is in neither list while the insertion event stays in the log. That window is
 * not a delivery failure — the message was durably recorded and the target's own
 * driver was the one consuming it — and treating it as one would invite a
 * duplicate re-delivery of a message the Session already took.
 */
export function messageRecorded(events: readonly SessionEvent[], messageId: string): boolean {
  return events.some(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.id === messageId))
}

/**
 * Read back the body of a cited `tool/call`: the evidence behind a question or an
 * answer, straight from the Session that sent it.
 *
 * A live Session is flushed first — the cited event must be durable before the
 * Task store commits an intent that cites it, because recovery reads the body
 * from the log and a body that only ever existed in a write buffer is not a
 * source. Refusals are named: an absent Session, an absent seq, an unreadable
 * Session, a Session with no durability barrier, and an event that is not the
 * `tool/call` it is cited as are five different things, and a caller that
 * cannot tell them apart would record the wrong fact.
 */
export async function readToolCallBody(deps: MessageDeliveryDeps, ref: ToolCallRef): Promise<ToolCallBody> {
  const sessionId = SessionId(ref.sessionId)
  const live = deps.sessions.get(sessionId)
  if (live !== undefined) await witnessBarrier(deps, live, sessionId)
  let window: SessionEventWindow
  try {
    window = await deps.sessionQuery.readEvent({ sessionId, seq: SessionSeq(ref.seq) })
  } catch (error: unknown) {
    throw sourceReadRefusal(String(sessionId), ref.seq, error)
  }
  const event = window.target
  if (event.type !== 'tool/call' || typeof event.data.name !== 'string' || event.data.name === '') {
    throw new MessageDeliveryRefusal(
      'source-not-tool-call',
      `agent-runtime: session "${String(sessionId)}" seq ${ref.seq} is not a tool call (event type "${event.type}")`,
    )
  }
  return { name: event.data.name, arguments: event.data.arguments }
}

/**
 * The part of one Session's log a citation lookup needs: the Session it belongs
 * to, how many of its leading events are fork-inherited, and the events. Written
 * structurally so a caller that holds a Session log — this package's own
 * `SessionLogSnapshot`, or a reader that only kept these three fields — can be
 * searched without this module importing the query engine's types.
 */
export interface SessionOwnLog {
  /** The Session the events belong to; its id is the citation's `sessionId`. */
  readonly session: { readonly id: SessionId }
  /** How many leading events came from the fork's ancestor and are not this Session's own. */
  readonly inheritedEventCount: number
  /** The log's events, in seq order. */
  readonly events: readonly SessionEvent[]
}

/**
 * The citation of one `tool/call` inside a Session's *own* event suffix, found
 * by the call id the tool layer holds (A4 §F.1).
 *
 * Why the caller needs this at all: the body of a question or an answer is the
 * sender's own tool call, and the durable citation into it is a `(session, seq)`
 * pair, while what a tool call has in hand is its registration id
 * ({@link ToolCallRef} is what {@link readToolCallBody} takes). This is that
 * translation, as a pure read of a Session log the caller already has, so the
 * lookup rule — own suffix only, the *last* event for an id — lives beside the
 * citation type instead of in each caller.
 *
 * The suffix rule is the delivery fold's ({@link ownSuffix}): a fork-inherited
 * prefix belongs to the Session this one descends from, and a call made there is
 * not a call this Session made. The last event wins because a log is append-only
 * and an id — were it ever re-dispatched — would be answered by its latest
 * durable record.
 */
export function toolCallRefIn(log: SessionOwnLog, callId: string): ToolCallRef | undefined {
  const own = log.events.slice(log.inheritedEventCount)
  for (let index = own.length - 1; index >= 0; index -= 1) {
    const event = own[index] as SessionEvent
    if (event.type !== 'tool/call') continue
    if (String(event.data.callId) !== callId) continue
    return { sessionId: log.session.id, seq: event.seq }
  }
  return undefined
}

/**
 * Put one already-decided message into the target Session's inbox, at most once.
 *
 * Order: reconcile, then relay, then flush, then confirm. Reconcile-first is
 * what makes a retry harmless — a message already pending or already in history
 * is reported `already-present` without touching the inbox. The relay is
 * `agent.steer`, not `followup`: an answer must reach the target's next model
 * request, including one that is mid-turn (a followup would queue it behind the
 * current turn), and an idle target still opens a turn, which is what a question
 * addressed to a settled parent needs to be answered at all.
 *
 * The confirmation after the flush is deliberately wider than the retry fold
 * ({@link messageRecorded}): a target whose turn is already consuming the
 * message claims it out of the inbox before history takes it, and that window
 * must not be reported as a failed delivery. What `delivered` claims is exactly
 * what the log shows — the Session durably recorded this identity — never that
 * the model read it.
 *
 * A target with no live agent is `unavailable` before anything else happens: no
 * offline write, no resume, no substitute parent — the intent survives in the
 * Task store, and the recovery path is what brings the target back and calls
 * this again.
 */
export async function ensureAgentMessageDelivered(
  deps: MessageDeliveryDeps,
  intent: AgentMessageIntent,
): Promise<MessageDelivery> {
  const targetSessionId = SessionId(intent.targetSessionId)
  const agent = deps.agents.get(targetSessionId)
  if (agent === undefined) return { messageId: intent.messageId, status: 'unavailable' }
  if (await acceptedAlready(deps, targetSessionId, intent.messageId)) {
    return { messageId: intent.messageId, status: 'already-present' }
  }
  try {
    agent.steer(relayMessage(intent))
  } catch (error: unknown) {
    // DSH's inbox refuses a duplicate pending id synchronously
    // (`message "<id>" is already pending`): that is a concurrent delivery of the
    // same identity having won, not a failure.
    if (isAlreadyPending(error, intent.messageId)) return { messageId: intent.messageId, status: 'already-present' }
    throw error
  }
  await witnessBarrier(deps, agent.session, targetSessionId, 'target-not-durable')
  const own = await ownSuffix(deps, targetSessionId)
  if (!messageAccepted(own, intent.messageId) && !messageRecorded(own, intent.messageId)) {
    throw new MessageDeliveryRefusal(
      'delivery-unconfirmed',
      `agent-runtime: message "${intent.messageId}" was relayed to session "${String(targetSessionId)}" but is not in its log after the flush`,
    )
  }
  return { messageId: intent.messageId, status: 'delivered' }
}

/**
 * Reconcile a set of committed intents against the Sessions that hold them,
 * delivering exactly the ones that are missing (§F.1: "恢复只补缺失投递").
 *
 * This is the entry point A4's recovery path calls with the records the Task
 * store holds: it owns no ledger of its own (the delivered fact *is* the
 * target's fold, and a second record could disagree with it), it never rewrites
 * an intent, and it reports each record separately so one unreachable parent
 * cannot hide the others. Intents are delivered in the order given, so the
 * target's inbox keeps the order the caller recorded.
 */
export async function reconcileAgentMessageDeliveries(
  deps: MessageDeliveryDeps,
  intents: readonly AgentMessageIntent[],
): Promise<MessageDeliveryReport[]> {
  const reports: MessageDeliveryReport[] = []
  for (const intent of intents) {
    try {
      const delivery = await ensureAgentMessageDelivered(deps, intent)
      reports.push({ messageId: delivery.messageId, status: delivery.status })
    } catch (error: unknown) {
      reports.push({ messageId: intent.messageId, status: 'refused', reason: messageOf(error) })
    }
  }
  return reports
}

/**
 * The durability barrier, as the two callers state it: `session/flush` reaching
 * no listener means nothing stores this Session, so neither a cited body nor a
 * delivery can be witnessed. A refusal here is not a delivery failure — the
 * caller keeps the intent and can retry.
 */
async function witnessBarrier(
  deps: MessageDeliveryDeps,
  session: Session,
  sessionId: SessionId,
  code: MessageRefusalCode = 'source-not-durable',
): Promise<void> {
  let durable: boolean
  try {
    durable = await deps.sessions.flush(session)
  } catch (error: unknown) {
    throw new MessageDeliveryRefusal(
      code,
      `agent-runtime: session "${String(sessionId)}" could not be flushed: ${messageOf(error)}`,
      { cause: error },
    )
  }
  if (!durable) {
    throw new MessageDeliveryRefusal(
      code,
      `agent-runtime: session "${String(sessionId)}" has no durability barrier (no session/flush participant)`,
    )
  }
}

/** Whether the target Session's own suffix already holds the identity. */
async function acceptedAlready(
  deps: MessageDeliveryDeps,
  sessionId: SessionId,
  messageId: string,
): Promise<boolean> {
  return messageAccepted(await ownSuffix(deps, sessionId), messageId)
}

/**
 * Read one Session's own event suffix (without the fork-inherited prefix). A
 * failed read is a refusal, never an assumed "nothing there": a delivery decided
 * from an unreadable log could duplicate a message the Session already holds.
 */
async function ownSuffix(deps: MessageDeliveryDeps, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  let snapshot: SessionLogSnapshot
  try {
    snapshot = await deps.sessionQuery.readSession(sessionId)
  } catch (error: unknown) {
    throw new MessageDeliveryRefusal(
      'target-unreadable',
      `agent-runtime: target session "${String(sessionId)}" could not be read, so whether a message was accepted cannot be decided: ${messageOf(error)}`,
      { cause: error },
    )
  }
  return snapshot.events.slice(snapshot.inheritedEventCount)
}

/** The pending inbox one durable suffix describes, folded the way DSH replays it. */
function pendingInboxMessages(events: readonly SessionEvent[]): UserMessage[] {
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    inbox[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
  }
  return [...inbox['next-turn'], ...inbox['next-step']]
}

/** Whether one thrown error is DSH's duplicate-pending-inbox refusal for this id. */
function isAlreadyPending(error: unknown, messageId: string): boolean {
  return error instanceof Error && error.message === `message "${messageId}" is already pending`
}

/** Name one refused source read from the error the session read path raised. */
function sourceReadRefusal(sessionId: string, seq: number, error: unknown): MessageDeliveryRefusal {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'SESSION_QUERY_EVENT_NOT_FOUND') {
    return new MessageDeliveryRefusal(
      'source-event-missing',
      `agent-runtime: session "${sessionId}" has no event at seq ${seq}`,
      { cause: error },
    )
  }
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
    return new MessageDeliveryRefusal(
      'source-session-missing',
      `agent-runtime: session "${sessionId}" does not exist`,
      { cause: error },
    )
  }
  return new MessageDeliveryRefusal(
    'source-unreadable',
    `agent-runtime: session "${sessionId}" could not be read: ${messageOf(error)}`,
    { cause: error },
  )
}

/** One line of an unknown failure, for refusals that carry a cause. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
