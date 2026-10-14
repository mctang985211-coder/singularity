import type { Agent, AgentHandle, AgentOptions, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { refuse } from '../protocol/refusal.ts'

interface RuntimeSeams {
  readonly sessionPersistence?: SessionPersistence | undefined
  readonly sessions?: SessionStore | undefined
  readonly agents?: AgentRegistry | undefined
  readonly agentLoop?: unknown
  get?(name: string): unknown
}
export interface AgentSessionRequest {
  readonly agentId: string
  readonly resume: boolean
  readonly cwd?: string
  readonly preset?: string
  readonly agentOptions?: AgentOptions
  readonly setup?: AgentSetup
}
export interface OpenedAgentSession {
  readonly agentId: string
  readonly sessionId: string
  readonly resumed: boolean
  readonly agent: Agent
}
interface Claim {
  readonly handle: AgentHandle
  closing?: Promise<void>
}
const claims = new Map<string, Claim>()
const service = <T>(ctx: RuntimeSeams, name: keyof Omit<RuntimeSeams, 'get'>): T => {
  const found = ctx.get === undefined ? ctx[name] : ctx.get(name)
  if (found === undefined) refuse('malformed-declaration', `agent sessions require ctx.${name}`)
  return found as T
}
export function assertRuntimeSeams(ctx: RuntimeSeams): void {
  for (const name of ['sessionPersistence', 'sessions', 'agents', 'agentLoop'] as const) service(ctx, name)
}
export async function openAgentSession(ctx: RuntimeSeams, request: AgentSessionRequest): Promise<OpenedAgentSession> {
  assertRuntimeSeams(ctx)
  const sessionId = agentSessionIdOf(request.agentId)
  if (claims.has(sessionId)) refuse('concurrent-writer', `session ${sessionId} already has an owned handle`)
  const persistence = service<SessionPersistence>(ctx, 'sessionPersistence')
  const registry = service<AgentRegistry>(ctx, 'agents')
  const persisted = await persistence.stat(sessionId)
  if (request.resume !== (persisted !== undefined))
    refuse('illegal-transition', `session ${sessionId}: ${request.resume ? 'resume requires persisted history' : 'create requires a new identity'}`)
  let handle: AgentHandle
  try {
    const options = {
      ...(request.setup === undefined ? {} : { setup: request.setup }),
      ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
    }
    handle = request.resume
      ? await registry.resume({ resumeSessionId: sessionId, ...options })
      : await registry.create({ sessionId, ...options, meta: {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.preset === undefined ? {} : { agentPreset: request.preset }),
      } })
  } catch (error) {
    if (error instanceof SessionAlreadyOwnedError) refuse('concurrent-writer', error.message)
    refuse('write-not-durable', `session ${sessionId}: ${String(error)}`)
  }
  claims.set(sessionId, { handle })
  return { agentId: request.agentId, sessionId, resumed: request.resume, agent: handle.agent }
}
export async function closeAgentSession(agentId: string): Promise<void> {
  const sessionId = agentSessionIdOf(agentId)
  const claim = claims.get(sessionId)
  if (claim === undefined) return
  claim.closing ??= claim.handle.dispose().then(() => { claims.delete(sessionId) })
  try { await claim.closing } catch (error) {
    delete claim.closing
    refuse('write-not-durable', `session ${sessionId} could not close: ${String(error)}`)
  }
}
export function agentSessionIdOf(agentId: string): SessionId {
  if (agentId.length === 0) refuse('malformed-declaration', 'agentId must be nonempty')
  return SessionId(`singularity:agent:${agentId}`)
}
