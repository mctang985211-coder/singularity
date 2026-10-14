import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { refuse } from '../protocol/refusal.ts'
import { agentSessionIdOf, openAgentSession, closeAgentSession } from './agent-session.ts'
import { schedulerMessage } from './task-message.ts'
import { postIdentifiedMessage } from './identified-message.ts'

export interface ChildSessionSeams {
  readonly sessionPersistence?: SessionPersistence | undefined
  readonly sessions?: SessionStore | undefined
  readonly agents?: AgentRegistry | undefined
  readonly agentLoop?: unknown
  readonly agentPresets?: {
    composeFrom(ctx: unknown, source: unknown): string | undefined
    mount(ctx: unknown, id: string): Promise<unknown>
  } | undefined
  get?(name: string): unknown
}
export interface ChildSessionRequest {
  readonly agentId: string
  readonly cwd: string
  readonly parent: Agent
  readonly model: { readonly provider: string; readonly model: string }
  readonly message: UserMessage
  readonly signal: AbortSignal
  readonly preset?: 'singularity-review'
}
export interface ChildSession {
  readonly agentId: string
  readonly sessionId: string
  readonly resumed: boolean
  readonly agent: Agent | undefined
  readonly delivery: 'posted' | 'pending' | 'entered'
  post(message: UserMessage): Promise<'posted' | 'pending' | 'entered'>
  wait(): Promise<void>
  stop(): void
  close(): Promise<void>
}
export async function openChildSession(seams: ChildSessionSeams, request: ChildSessionRequest): Promise<ChildSession> {
  request.signal.throwIfAborted()
  const get = <T>(name: keyof Omit<ChildSessionSeams, 'get'>): T => {
    const found = seams.get === undefined ? seams[name] : seams.get(name)
    if (found === undefined) refuse('malformed-declaration', `node sessions require ctx.${name}`)
    return found as T
  }
  const persistence = get<SessionPersistence>('sessionPersistence')
  const sessions = get<SessionStore>('sessions')
  const presets = get<NonNullable<ChildSessionSeams['agentPresets']>>('agentPresets')
  const persisted = await persistence.stat(agentSessionIdOf(request.agentId))
  const reasoningEffort = (request.parent.session.requestHeader()?.config ?? request.parent.options).reasoningEffort
  const opened = await openAgentSession(seams, {
    agentId: request.agentId, resume: persisted !== undefined, cwd: request.cwd,
    preset: request.preset ?? 'singularity-next',
    agentOptions: { ...request.model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
    setup: async ctx => {
      if (request.preset !== undefined) await presets.mount(ctx, request.preset)
      else presets.composeFrom(ctx, request.parent.ctx)
    },
  })
  const post = (message: UserMessage) => postIdentifiedMessage(seams, opened.agent, message)
  const stop = () => opened.agent.cancel({ kind: 'parent' }, { keepInbox: true })
  try {
    request.signal.throwIfAborted()
    let delivery = await post(request.message)
    if (opened.resumed && delivery === 'entered') {
      if (request.message.source.kind !== 'singularity') refuse('malformed-declaration', 'task continuation requires an identified Task source')
      delivery = await post(schedulerMessage({ ...request.message.source, purpose: 'resume', factSeq: Number(opened.agent.session.seq) },
        'Continue this exact Task/Run from its durable session and frozen workspace.\n' +
        request.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')))
    }
    return { ...opened, agentId: String(opened.agent.id), delivery, post, stop,
      wait: async () => {
        await opened.agent.whenIdle()
        if (!await sessions.flush(opened.agent.session)) refuse('write-not-durable', `session ${opened.sessionId} has no durability listener`)
      },
      close: () => closeAgentSession(request.agentId),
    }
  } catch (error) {
    stop()
    await closeAgentSession(request.agentId)
    throw error
  }
}
