import { lastAssistantStreamChunk, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { Apparatus } from './apparatus.ts'

export interface CampaignLimits {
  readonly nativeTokens: number
  readonly unknownUsageReservations?: readonly { readonly sessionId: string; readonly seq: number; readonly tokens: number }[]
}
const usageOf = (event: SessionEvent): number | undefined => event.type === 'assistant/message' ? event.data.usage?.totalTokens
  : event.type === 'assistant/attempt' ? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage.totalTokens : undefined
const isAttempt = (event: SessionEvent): boolean => event.type === 'assistant/message' || event.type === 'assistant/attempt'

export function nativeTokensOf(events: readonly SessionEvent[]): number {
  return events.filter(isAttempt).reduce((total, event) => {
    const usage = usageOf(event)
    if (usage === undefined) refuse('budget-exhausted', `native usage is unknown at session event ${event.seq}; model calls must stop`)
    return total + usage
  }, 0)
}

export function createCampaignBudget(apparatus: Apparatus, limits: CampaignLimits) {
  assertClosedKeys({ ...limits }, ['nativeTokens', 'unknownUsageReservations'], 'campaign budget')
  if (!Number.isSafeInteger(limits.nativeTokens) || limits.nativeTokens < 1)
    refuse('malformed-declaration', 'campaign budget nativeTokens must be a positive safe integer')
  const reservations = limits.unknownUsageReservations ?? []
  const positions = new Set<string>()
  for (const reservation of reservations) {
    assertClosedKeys({ ...reservation }, ['sessionId', 'seq', 'tokens'], 'unknown usage reservation')
    if (reservation.sessionId.length === 0 || !Number.isSafeInteger(reservation.seq) || reservation.seq < 0 ||
      !Number.isSafeInteger(reservation.tokens) || reservation.tokens < 1)
      refuse('malformed-declaration', 'usage reservations require an exact session/event and a positive token upper bound')
    const position = JSON.stringify([reservation.sessionId, reservation.seq])
    if (positions.has(position)) refuse('malformed-declaration', 'duplicate unknown usage reservation')
    positions.add(position)
  }
  const sessions = new Map<string, Map<number, SessionEvent>>()
  const pending = new Map<string, { output: number; usage?: number; unknown?: true }>()
  const report = () => {
    const missing = [...sessions.entries()].flatMap(([sessionId, events]) => [...events.values()]
      .filter(event => isAttempt(event) && usageOf(event) === undefined).map(event => ({ sessionId, seq: Number(event.seq) })))
    const reserved = reservations.filter(held => missing.some(event => event.sessionId === held.sessionId && event.seq === held.seq))
    const unknown: { sessionId: string; seq: number | null }[] = missing.filter(event =>
      !reserved.some(held => held.sessionId === event.sessionId && held.seq === event.seq))
    unknown.push(...[...pending.entries()].filter(([, request]) => request.unknown === true).map(([sessionId]) => ({ sessionId, seq: null })))
    const known = [...sessions.values()].flatMap(events => [...events.values()]).filter(isAttempt)
      .reduce((sum, event) => sum + (usageOf(event) ?? 0), 0)
    const inFlight = [...pending.values()].reduce((sum, request) => sum + (request.usage ?? 0), 0)
    const reservedTokens = reserved.reduce((sum, held) => sum + held.tokens, 0)
    return { tokens: unknown.length === 0 ? known + inFlight + reservedTokens : null,
      knownTokens: known + inFlight, reservedTokens, reservations: reserved, unknown }
  }
  const beforeRequest = (maximum?: number): number => {
    const observed = report()
    if (observed.tokens === null) refuse('budget-exhausted', 'native usage is unknown; no further model request is permitted')
    const reserved = [...pending.values()].filter(request => request.usage === undefined).reduce((sum, request) => sum + request.output, 0)
    const remaining = limits.nativeTokens - observed.tokens - reserved
    if (remaining <= 0) refuse('budget-exhausted', `native token budget ${limits.nativeTokens} is exhausted; usage plus explicit reservations ${observed.tokens}`)
    return Math.min(maximum ?? remaining, remaining)
  }
  const observe = (sessionId: string, event: SessionEvent): void => {
    if (!isAttempt(event)) return
    let events = sessions.get(sessionId)
    if (events === undefined) { events = new Map(); sessions.set(sessionId, events) }
    events.set(Number(event.seq), event)
    pending.delete(sessionId)
  }
  const enroll = async (sessionId: string): Promise<void> => {
    if (sessions.has(sessionId)) return
    const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
    try {
      const { events } = await handle.read()
      sessions.set(sessionId, new Map())
      for (const event of events) observe(sessionId, event)
    } finally { await handle.close() }
  }
  return {
    limits, report, beforeRequest, observe, enroll,
    owns: (sessionId: string): boolean => sessions.has(sessionId),
    restore: async () => {
      const owners = new Set([...apparatus.store.load().statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION).values()].map(agent => agent.sessionId))
      for (const session of await apparatus.persistence.list())
        if (owners.has(String(session.header.id))) await enroll(String(session.header.id))
    },
    startRun: async <T>(_taskId: string, _runId: string, commit: () => Promise<T>): Promise<T> => {
      beforeRequest()
      return commit()
    },
    stream: async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>, stop: () => void): AsyncIterable<StreamChunk> {
      const sessionId = String(options.sessionId)
      const allowance = beforeRequest(options.maxTokens)
      if (options.maxTokens === undefined || options.maxTokens > allowance)
        refuse('budget-exhausted', 'the model request has no output cap within its remaining campaign budget')
      const request: { output: number; usage?: number; unknown?: true } = { output: options.maxTokens }
      pending.set(sessionId, request)
      let settled = false
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') {
            if (chunk.usage.totalTokens === undefined) {
              request.unknown = true
              stop()
              refuse('budget-exhausted', 'provider usage is unknown; campaign stopped')
            }
            request.usage = chunk.usage.totalTokens
            if (report().tokens! >= limits.nativeTokens) stop()
          }
          if (chunk.type === 'finish') {
            if (request.usage === undefined) {
              request.unknown = true
              stop()
              refuse('budget-exhausted', 'provider attempt settled with unknown usage; campaign stopped')
            }
            settled = true
          }
          yield chunk
        }
      } finally {
        if (!settled && request.usage === undefined) { request.unknown = true; stop() }
      }
    },
  }
}
export type CampaignBudget = ReturnType<typeof createCampaignBudget>
