import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { assertContiguous, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ChildSessionSeams } from './child-session.ts'

export async function postIdentifiedMessage(seams: Pick<ChildSessionSeams, 'sessions' | 'sessionPersistence' | 'get'>, agent: Agent, message: UserMessage,
  post: (message: UserMessage) => void = message => agent.followup(message)): Promise<'posted' | 'pending' | 'entered'> {
  const sessions = (seams.get === undefined ? seams.sessions : seams.get('sessions')) as SessionStore | undefined
  const persistence = (seams.get === undefined ? seams.sessionPersistence : seams.get('sessionPersistence')) as SessionPersistence | undefined
  if (sessions === undefined || persistence === undefined)
    refuse('malformed-declaration', 'identified delivery requires native sessions and session persistence')
  const eventCount = Number(agent.session.seq)
  if (!await sessions.flush(agent.session)) refuse('write-not-durable', `session "${agent.session.id}" has no durability listener`)
  const handle = await persistence.open(SessionId(String(agent.session.id)), 'read')
  const sourceDigest = digestOf(message.source)
  const contentDigest = digestOf(message.content)
  const matches = (candidate: UserMessage): boolean => {
    if (digestOf(candidate.source) !== sourceDigest) return false
    if (digestOf(candidate.content) !== contentDigest) refuse('command-conflict', 'the native message source was posted with different content')
    return true
  }
  let seen = false
  let entered = false
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  try {
    const { events } = await handle.read(0, eventCount)
    if (events.length !== eventCount) refuse('write-not-durable', 'the identified source prefix is not fully persisted')
    assertContiguous(handle.id, events, 0)
    for (const event of events) {
      if (event.type === 'agent/inbox/spliced') {
        for (const candidate of event.data.inserted) if (matches(candidate)) seen = true
        inbox[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
      } else if (event.type === 'user/message' && matches(event.data)) entered = true
    }
  } finally { await handle.close() }
  if (entered) return 'entered'
  if (Object.values(inbox).some(messages => messages.some(matches))) {
    agent.wake()
    return 'pending'
  }
  if (seen) refuse('illegal-transition', 'the native identified message was claimed but its delivery is unconfirmed')
  post(message)
  if (!await sessions.flush(agent.session)) refuse('write-not-durable', `session "${agent.session.id}" has no durability listener`)
  return 'posted'
}
