/** Relay one committed message identity into a target Session's inbox and report what its log witnesses (A4 §F.1).
 * @module @dangosys/dsh-singularity-agent-runtime/messages */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventReadRequest, SessionEventWindow, SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
// The `agent-message` source kind is declared into DSH's `MessageSourceMap` by the subagent package.
import type {} from '@deepseek-ai/dsh-subagent'

/** Why one delivery or source read was refused; every refusal is named for the caller's next move. */
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

/** One message the Task store has already decided to deliver: identity, the two Sessions, and the text. */
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

/** What one delivery attempt settled as: `delivered`, `already-present`, or `unavailable` (nothing attempted). */
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

/** The services one delivery reaches, narrowed to the three capabilities `./messages.ts` declares and no more. */
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

/** The message body an answer carries into the asking Session: both identities, then what the parent answered. */
export function answerMessageText(answerId: string, questionId: string, answer: string): string {
  return `[task-answer ${answerId} for ${questionId}] ${answer}`
}

/** Build the identified, frozen relay message one intent delivers (pure, so a caller can inspect it). */
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

/** Whether one Session's own event suffix already holds the identity, in history or still pending. */
export function messageAccepted(events: readonly SessionEvent[], messageId: string): boolean {
  return (
    events.some(event => event.type === 'user/message' && event.data.id === messageId) ||
    pendingInboxMessages(events).some(message => message.id === messageId)
  )
}

/** Whether the log durably records that this identity entered the Session's inbox (wider than `messageAccepted`). */
function messageRecorded(events: readonly SessionEvent[], messageId: string): boolean {
  return events.some(
    event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === messageId),
  )
}

/** Read back the body of a cited `tool/call`, flushing the sending Session first; refusals are named. */
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

/** The part of one Session's log the citation lookup needs, written structurally. */
export interface SessionOwnLog {
  /** The Session the events belong to; its id is the citation's `sessionId`. */
  readonly session: { readonly id: SessionId }
  /** How many leading events came from the fork's ancestor and are not this Session's own. */
  readonly inheritedEventCount: number
  /** The log's events, in seq order. */
  readonly events: readonly SessionEvent[]
}

/** One Session's own event suffix, without the fork-inherited prefix. */
export function ownSuffix(log: SessionOwnLog): readonly SessionEvent[] {
  return log.events.slice(log.inheritedEventCount)
}

/** The citation of one `tool/call` inside a Session's own suffix, found by the call id (last event wins). */
export function toolCallRefIn(log: SessionOwnLog, callId: string): ToolCallRef | undefined {
  const own = ownSuffix(log)
  for (let index = own.length - 1; index >= 0; index -= 1) {
    const event = own[index] as SessionEvent
    if (event.type !== 'tool/call') continue
    if (String(event.data.callId) !== callId) continue
    return { sessionId: log.session.id, seq: event.seq }
  }
  return undefined
}

/** Put one committed identity into the target inbox at most once (reconcile → relay → flush → confirm). */
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
    // DSH's inbox refuses a duplicate pending id synchronously: a concurrent delivery won, not a failure.
    if (isAlreadyPending(error, intent.messageId)) return { messageId: intent.messageId, status: 'already-present' }
    throw error
  }
  await witnessBarrier(deps, agent.session, targetSessionId, 'target-not-durable')
  const own = await ownSuffixOf(deps, targetSessionId)
  if (!messageAccepted(own, intent.messageId) && !messageRecorded(own, intent.messageId)) {
    throw new MessageDeliveryRefusal(
      'delivery-unconfirmed',
      `agent-runtime: message "${intent.messageId}" was relayed to session "${String(targetSessionId)}" but is not in its log after the flush`,
    )
  }
  return { messageId: intent.messageId, status: 'delivered' }
}

/** Deliver exactly the committed intents that are missing, in order, reporting each record separately. */
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

/** The durability barrier: `session/flush` reaching no listener means the body cannot be witnessed. */
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
async function acceptedAlready(deps: MessageDeliveryDeps, sessionId: SessionId, messageId: string): Promise<boolean> {
  return messageAccepted(await ownSuffixOf(deps, sessionId), messageId)
}

/** Read one Session's own event suffix; a failed read is a refusal, never an assumed "nothing there". */
async function ownSuffixOf(deps: MessageDeliveryDeps, sessionId: SessionId): Promise<readonly SessionEvent[]> {
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
  return ownSuffix(snapshot)
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

/** One line of an unknown failure, for refusals that carry a cause. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
