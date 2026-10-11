import type { Agent, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { refuse } from '../protocol/refusal.ts'
import { openAgentSession, type OpenedAgentSession } from './agent-session.ts'

/**
 * The seams a child session is opened over.
 *
 * `agentPresets` is optional and the only one that may be absent: a deployment that mounts no preset
 * registry has no composition to replay, and {@link openChildSession} refuses then rather than
 * creating a child whose tool registry would be empty — a child that can do nothing is worse than a
 * named refusal, because it fails later and elsewhere.
 */
export interface ChildSessionSeams {
  readonly sessionPersistence?: SessionPersistence | undefined
  readonly sessions?: SessionStore | undefined
  readonly agents?: AgentRegistry | undefined
  readonly agentLoop?: unknown
  /**
   * The preset registry, read through `ctx.get` rather than as a property: a cordis plugin context
   * throws on a property access for a service it did not `inject`, and an optional seam that throws
   * instead of reading `undefined` is not optional.
   */
  readonly agentPresets?: { composeFrom(ctx: unknown, parent: unknown): void } | undefined
  /** Resolve one service without that trap. See {@link ChildSessionSeams.agentPresets}. */
  get?(name: string): unknown
}

/** What one child session is opened for: who it is, whose it is, and what it must be told. */
export interface ChildSessionRequest {
  /** The child's agent id. Derived by the caller; the session id follows from it. */
  readonly agentId: string
  /** Absolute working directory for a freshly created session header. */
  readonly cwd: string
  /** The parent's live agent: the preset is joined from its context, the route read from its header. */
  readonly parent: Agent
  /**
   * The model route the child runs on. **Not inherited**: `create` takes it or the child has none,
   * and a child with no provider fails its first step with a bare upstream error
   * (`agent "…" has no provider/model`), far from the call that caused it.
   */
  readonly model: { readonly provider: string; readonly model: string }
  /**
   * Composes the child's context, exactly as a preset row would for a top-level session.
   *
   * The caller supplies this because only the caller knows what the child must be able to reach.
   * It must join the parent's preset — a preset is a **scope parent**, not a field, so a child
   * created with a preset name and no join gets an empty tool registry — and it is invoked on
   * create and on resume both.
   */
  readonly compose: AgentSetup
}

/** One live child session: what it is, and how to put something in its inbox. */
export interface ChildSession extends OpenedAgentSession {
  /** Enqueue an identified message after setup resolves; completion belongs to the owner. */
  post(message: UserMessage): void
  /** Await resource quiescence and durability. Task/Run success is read from committed facts. */
  wait(): Promise<void>
  /** Stop whatever it is doing. `keepInbox` leaves undelivered messages queued. */
  stop(): void
}

/**
 * Open one child session and hand back a way to talk to it.
 *
 * `resume` is the caller's decision and it is not a guess: a child whose session the medium already
 * holds is resumed, because recreating it would either be refused by the medium or destroy history.
 * A child that is live **in this process** cannot be resumed at all — the write lease is exclusive
 * and the holder here is this module — so the refusal names that rather than surfacing as an
 * upstream lease error.
 */
export async function openChildSession(seams: ChildSessionSeams, request: ChildSessionRequest): Promise<ChildSession> {
  // Read through `get`, never as a property. A cordis context refuses a *property* access for a service
  // the accessing plugin did not declare in `inject` — `cannot get property "agentPresets" without
  // inject` — which is a throw, not the `undefined` an optional seam is supposed to look like. `get`
  // asks the same question without that trap, so a deployment with no preset registry gets the named
  // refusal below instead of a crash from a line that never expected to run.
  const presets = seams.get?.('agentPresets') as { composeFrom(ctx: unknown, parent: unknown): void } | undefined
  if (presets === undefined)
    refuse(
      'malformed-declaration',
      `cannot open child session "${request.agentId}": this deployment mounts no agent-preset registry, and a child that joins no preset sees an empty tool registry — it could not do the work it is being opened for`,
    )
  const opened = await openAgentSession(seams as Parameters<typeof openAgentSession>[0], {
    agentId: request.agentId,
    resume: true,
    cwd: request.cwd,
    parentAgent: request.parent,
    agentOptions: { provider: request.model.provider, model: request.model.model },
    setup: (childCtx, agent) => {
      // Joining the parent's preset is what gives the child its parent's composition; the caller's
      // own `compose` then adds whatever this deployment mounts per child. Both, every time: on
      // resume nothing about a scope survives, so a composition that ran only on create would
      // produce a child that has history and no tools.
      presets.composeFrom(childCtx, request.parent.ctx)
      return request.compose(childCtx, agent)
    },
  })
  return {
    ...opened,
    post: message => opened.agent.followup(message),
    wait: async () => {
      await opened.agent.whenIdle()
      const sessions = (seams.get === undefined ? seams.sessions : seams.get('sessions')) as SessionStore
      if (!await sessions.flush(opened.agent.session))
        refuse('write-not-durable', `session "${opened.sessionId}" has no durability listener`)
    },
    stop: () => opened.agent.cancel({ kind: 'parent' }, { keepInbox: true }),
  }
}
