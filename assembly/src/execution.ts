import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { assertContiguous } from '@deepseek-ai/dsh-session-persistence'
import type { ToolDispatchExecution, ToolExecution, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'

export type Admission = (exec: Readonly<ToolExecution>) => string | undefined
export interface TurnFailure {
  readonly sessionId: string
  readonly turn: number
  readonly seq: number
  readonly reason: Extract<TurnEndReason, { kind: 'error' | 'aborted' }>
}
export type TurnFailureHandler = (failure: TurnFailure) => void
export interface TranscriptSource {
  readonly sessionId: string
  readonly eventCount: number
  readonly digest: string
}
export interface Execution {
  assertCaller(exec: ToolRunContext): Agent
  drain(exec: ToolRunContext): Promise<void>
  sealTranscript(exec: ToolRunContext): Promise<TranscriptSource>
  close(): Promise<void>
}
interface ActiveExecution {
  readonly exec: ToolDispatchExecution
  readonly controller: AbortController
  readonly done: Promise<void>
  failure?: { readonly error: unknown }
}

export function createExecution(ctx: Context, admission: Admission, onTurnFailure: TurnFailureHandler): Execution {
  const active = new Map<ToolExecutionToken, ActiveExecution>()
  const borrowed = new WeakSet<Agent>()
  const failedTurns = new WeakMap<Agent, number>()
  let closed = false
  let closing: Promise<void> | undefined
  const assertCaller = (exec: ToolRunContext): Agent => {
    if (closed) refuse('illegal-transition', 'the execution port has closed')
    const agent = exec.agent
    if (agent === undefined || ctx.agents.get(agent.id) !== agent)
      refuse('unknown-emitter-role', 'the caller is not the exact live DSH registry agent')
    if (agent.id !== agent.session.id) refuse('malformed-declaration', 'the caller agent and session identities differ')
    borrowed.add(agent)
    return agent
  }
  const wait = async (entries: readonly ActiveExecution[]): Promise<void> => {
    await Promise.all(entries.map(entry => entry.done))
    const failed = entries.find(entry => entry.failure !== undefined)
    if (failed?.failure !== undefined) throw failed.failure.error
  }
  const reasonOf = (exec: Readonly<ToolExecution>): string | undefined => {
    if (closed && exec.agent !== undefined && borrowed.has(exec.agent)) return 'the execution port has closed'
    return admission(exec)
  }
  const guard = ctx.tools.guard(reasonOf)
  const listen = ctx.on('tools/execute', async (exec, next) => {
    const reason = reasonOf(exec)
    if (reason !== undefined) refuse('illegal-transition', reason)
    const controller = new AbortController()
    const original = exec.signal
    exec.signal = AbortSignal.any([original, controller.signal])
    let resolve!: () => void
    const done = new Promise<void>(settled => { resolve = settled })
    const entry: ActiveExecution = { exec, controller, done }
    active.set(exec.token, entry)
    try {
      return await next()
    } catch (error) {
      entry.failure = { error }
      throw error
    } finally {
      exec.signal = original
      active.delete(exec.token)
      resolve()
    }
  })
  const report = (agent: Agent, failure: TurnFailure): void => {
    if (ctx.agents.get(agent.id) !== agent || (failedTurns.get(agent) ?? -1) >= failure.turn) return
    failedTurns.set(agent, failure.turn)
    onTurnFailure(failure)
  }
  const crashed = ctx.on('agent/error', ({ agent, turn, error }) => {
    report(agent, { sessionId: String(agent.session.id), turn, seq: Number(agent.session.seq),
      reason: { kind: 'error', error: { code: 'DSH_AGENT_ERROR', message: error instanceof Error ? error.message : String(error) } } })
  })
  const ended = ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || (event.data.reason.kind !== 'error' && event.data.reason.kind !== 'aborted')) return
    const agent = ctx.agents.get(session.id)
    if (agent?.session !== session) return
    report(agent, { sessionId: String(session.id), turn: event.data.turn, seq: Number(event.seq), reason: event.data.reason })
  })
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true
    ended()
    crashed()
    const granted = [...active.values()].filter(entry => entry.exec.agent !== undefined && borrowed.has(entry.exec.agent))
    for (const entry of granted) entry.controller.abort(new Error('the execution port has closed'))
    await wait(granted)
  })()
  ctx.effect(function* () {
    yield guard
    yield listen
    yield ended
    yield crashed
    yield close
  })
  return {
    assertCaller,
    drain: async exec => {
      const agent = assertCaller(exec)
      const ancestors = new Set<ToolExecutionToken>()
      let token: ToolExecutionToken | undefined = exec.token
      while (token !== undefined) {
        ancestors.add(token)
        token = active.get(token)?.exec.parent
      }
      await wait([...active.values()].filter(entry => entry.exec.agent === agent && !ancestors.has(entry.exec.token)))
    },
    sealTranscript: async exec => {
      const agent = assertCaller(exec)
      const sessionId = String(agent.session.id)
      const eventCount = Number(agent.session.seq)
      if (!await ctx.sessions.flush(agent.session)) refuse('write-not-durable', `session "${sessionId}" has no durability listener`)
      const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read')
      try {
        const { events } = await handle.read(0, eventCount)
        if (events.length !== eventCount) refuse('write-not-durable', `session "${sessionId}" did not persist the sealed ${eventCount} events`)
        assertContiguous(handle.id, events, 0)
        return { sessionId, eventCount, digest: digestOf({ sessionId, eventCount, events }) }
      } finally {
        await handle.close()
      }
    },
    close,
  }
}
