/**
 * A real DSH agent session: created, or resumed for the same exact identity.
 *
 * **Why this exists.** `agent/opened{agentId, role, sessionId}` is a log fact; the agent behind it
 * is a live DSH object. E3 **references** that runtime object instead of modelling it
 * (`docs/phase-b-design.md` §3), so exactly one place must turn a supplied agent id into a real
 * `AgentRegistry` session — created fresh, or resumed for the same session id — and hand the write
 * lease back when the caller is done. That place is this module.
 *
 * **What DSH owns, and what is ours.** DSH owns the bytes, the single-writer lease, the agent loop
 * and the repair of an interrupted log. Ours is the derivation of the session id from the agent id,
 * the create-or-resume decision, and the load-time refusal of a missing seam.
 *
 * **Three measured traps shape it** (`docs/context.md` §10):
 *
 * 1. A plugin mounted without its `inject` dependency is **silently absent** — `ctx.authorization` is
 *    `undefined` until a credentials provider exists. So {@link assertRuntimeSeams} refuses at load,
 *    by name, instead of letting an `undefined` be met mid-turn.
 * 2. `ctx.agents.resume()` **writes**: it appends a `session/end-seed` closer even to an already
 *    balanced log (observed). It needs the same single-writer lease as any other write, and while
 *    another handle holds that lease it fails with `SessionAlreadyOwnedError` rather than queueing.
 *    A resume is never read-only, so the lease is taken explicitly and the conflict is reported as
 *    our own `concurrent-writer` refusal.
 * 3. A non-contiguous append is refused with a **bare `Error`**, invisible to `instanceof` against
 *    the exported error classes. Resume failures are therefore not classified by class: the one
 *    class that carries meaning (the lease) is named, and every other failure becomes a named
 *    refusal of ours with the upstream name and message preserved in the detail.
 *
 * @module singularity-core/runtime/agent-session
 */

import type { Agent, AgentHandle, AgentOptions, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { refuse } from '../protocol/refusal.ts'

/** Every seam this module drives. Presence is checked by name; absence is loud, never `undefined`. */
const SEAM_NAMES = ['sessionPersistence', 'sessions', 'agents', 'agentLoop'] as const

/**
 * The upstream services this module drives, declared optionally because that is how a cordis service
 * that is absent actually looks: the property is simply not there. `ctx.agentLoop` is checked for
 * presence although this module never calls it, because `ctx.agents.create`/`resume` reject with a
 * bare `Error` when no factory is registered, and only `dsh-agent-loop` registers that factory.
 */
interface RuntimeSeams {
  readonly sessionPersistence?: SessionPersistence | undefined
  readonly sessions?: SessionStore | undefined
  readonly agents?: AgentRegistry | undefined
  readonly agentLoop?: unknown
  /**
   * Resolve one service without the property trap.
   *
   * A cordis plugin context **throws** on a property read of a service its plugin did not `inject` —
   * `cannot get property "sessions" without inject` — so `ctx.sessions` is not "the service or
   * undefined", it is the service or an exception. Every optional seam below is therefore read through
   * this, and a deployment that provides no child-session runtime gets the named refusal this module
   * already has rather than a `TypeError` reaching a tool result.
   */
  get?(name: string): unknown
}

/** The seams this module drives, each proven present. */
interface PresentSeams {
  readonly sessionPersistence: SessionPersistence
  readonly sessions: SessionStore
  readonly agents: AgentRegistry
}

/**
 * Refuse at load when a seam this module drives is missing, naming **each** absent one.
 *
 * A plugin mounted without its declared `inject` dependency is silently absent, so a missing seam
 * met mid-turn is a bug discovered far from its cause. `ctx.sessions` is checked even though this
 * module never calls it: the agent loop's resume path calls `ctx.sessions.prepare`, so its absence
 * would surface inside `resume` as a bare `TypeError`.
 */
export function assertRuntimeSeams(ctx: RuntimeSeams): void {
  requiredSeams(ctx)
}

/**
 * Resolve one seam, by name, without the property trap.
 *
 * A cordis plugin context **throws** on a property read of a service the plugin did not `inject`:
 * `ctx.sessions` is not "the service or undefined", it is the service or
 * `cannot get property "sessions" without inject`. `ctx.get` asks the same question and answers
 * `undefined`, so every seam is read through it when it exists — which is what makes this module's
 * promise ("a missing seam is a named refusal") true rather than merely written down. Measured: a
 * deployment without `sessions` in its inject list used to fail with the proxy's error reaching a
 * tool result, which is exactly the far-from-cause bug this check exists to prevent.
 */
function seamOf(ctx: RuntimeSeams, name: (typeof SEAM_NAMES)[number]): unknown {
  return ctx.get === undefined ? ctx[name] : ctx.get(name)
}

/** The check `assertRuntimeSeams` performs, narrowed for the callers below. */
function requiredSeams(ctx: RuntimeSeams): PresentSeams {
  const absent = SEAM_NAMES.filter(name => {
    const found = seamOf(ctx, name)
    return found === undefined || found === null
  }).map(name => `ctx.${name}`)
  if (absent.length > 0)
    refuse(
      'malformed-declaration',
      `the DSH runtime seams this module drives are absent: ${absent.join(', ')}; a plugin mounted without its inject dependency is silently absent, so a missing seam is refused here at load rather than met as an undefined at runtime`,
    )
  // The *resolved* services, not the context: returning `ctx as PresentSeams` would make every later
  // `const { agents } = seams` a property read again, which is the trap this function just avoided, and
  // the check would be decoration in front of the same throw.
  return {
    sessionPersistence: seamOf(ctx, 'sessionPersistence') as SessionPersistence,
    sessions: seamOf(ctx, 'sessions') as SessionStore,
    agents: seamOf(ctx, 'agents') as AgentRegistry,
  }
}

/** What a caller asks for: one supplied agent id, and whether persisted history is expected. */
export interface AgentSessionRequest {
  /** The supplied agent id. The session id is derived from it, never passed in raw. */
  readonly agentId: string
  /**
   * `true` when the caller believes this agent already has a persisted session, `false` for a first
   * open. A resume that finds nothing persisted **creates** the session instead of silently
   * reporting a resume, and reports `resumed: false`.
   */
  readonly resume: boolean
  /** Absolute working directory recorded on a freshly created session header. */
  readonly cwd?: string
  /** The model route a freshly created agent starts with. Omitted on resume: DSH keeps its own. */
  readonly agentOptions?: AgentOptions
  /**
   * The agent that owns this one, for a session that is somebody's child.
   *
   * Runtime ownership only: DSH records it in the session header as `parentSession`, which is the
   * durable link, and uses it to attribute the child's own delegation. It is not what makes the
   * child's tools exist — that is {@link setup}, and the two are separate for a measured reason
   * (`docs/phase-g2-design.md` §6): a child created with a preset *name* and no setup gets an empty
   * tool registry, because a preset is a scope parent rather than a field.
   */
  readonly parentAgent?: Agent
  /**
   * Composes the child's context: run after the context exists and before the agent is published.
   *
   * DSH invokes this on create **and** on resume, which is why it is a parameter of the request
   * rather than a step the caller performs afterwards — a resumed child must be recomposed, and a
   * caller that composed after `open` would compose only on the create path.
   */
  readonly setup?: AgentSetup
}

/** The identity the caller owns afterwards. No handle is exposed: the lease stays with this module. */
export interface OpenedAgentSession {
  readonly agentId: string
  readonly sessionId: string
  /** `true` only when an already-persisted session was resumed. */
  readonly resumed: boolean
  /**
   * The live agent, for the one thing a caller can only do with it: put a message in its inbox and
   * wait for it to go quiet. The lease stays here — this is the object, not the handle that holds
   * the write lease, and closing goes through {@link closeAgentSession}.
   */
  readonly agent: Agent
}

/** One live agent session this module opened, and the write lease that lives inside its handle. */
interface Claim {
  /** The context that took the lease. A second context in this process may not claim the same id. */
  readonly owner: RuntimeSeams
  readonly handle: AgentHandle
  /** One in-flight close every later caller awaits, so N concurrent closes dispose exactly once. */
  closing?: Promise<void> | undefined
  /** The last teardown failure. Cleared by a retry, which is why a failed claim stays registered. */
  failure?: unknown
}

/** One claim per session id: the handle is exposed only to its consumer, and this module is it. */
const CLAIMS = new Map<string, Claim>()

/**
 * Create the session fresh, or resume it for the same exact session id.
 *
 * `resume: true` on a session that was never created creates it (`resumed: false`); `resume: false`
 * on a session that already holds persisted history refuses rather than overwrite it. The handle is
 * kept here, so the write lease is released through {@link closeAgentSession}.
 */
export async function openAgentSession(ctx: RuntimeSeams, request: AgentSessionRequest): Promise<OpenedAgentSession> {
  const { sessionPersistence, agents } = requiredSeams(ctx)
  const sessionId = agentSessionIdOf(request.agentId)
  // Existence, not history: `stat` takes no ownership, and the backend's own `eventCount` is
  // optional (the JSONL backend does not provide it), so the medium's answer is used as-is.
  const persisted = await sessionPersistence.stat(sessionId)

  if (persisted !== undefined && !request.resume)
    refuse(
      'illegal-transition',
      `agent session ${sessionId} already holds persisted history; a fresh create must not overwrite it — open it with resume instead`,
    )

  const handle =
    persisted === undefined
      ? await createAgent(agents, sessionId, request)
      : await resumeAgent(agents, sessionId, request)

  const claimed = CLAIMS.get(sessionId)
  // A successful open proves the *medium* granted a new write handle; it does not prove this
  // module's earlier claim is gone. Replacing the claim would drop the only reference to a live
  // lease, leaving the session unwritable with nobody holding it, so a second claim is rolled back
  // and refused — by name, and recoverable: `closeAgentSession` releases the first one.
  if (claimed !== undefined) {
    await handle.dispose().catch(() => undefined)
    refuse(
      'concurrent-writer',
      `agent session ${sessionId} is already claimed in this process (${
        claimed.owner === ctx ? 'this context' : 'another context'
      } opened it); close that claim before opening the session again, so no write lease is left with no holder`,
    )
  }
  CLAIMS.set(sessionId, { owner: ctx, handle })
  return { agentId: request.agentId, sessionId, resumed: persisted !== undefined, agent: handle.agent }
}

/**
 * Release the write lease this module took for an agent session, in order, and stay idempotent.
 *
 * No context is required. The lease lives in the handle this module kept, and releasing it must work
 * even while the context that opened it is being torn down. The claim is dropped only after
 * `dispose()` has resolved, so a failed teardown stays registered and retryable — a claim dropped
 * first would leave the session unwritable with nobody holding it.
 */
export async function closeAgentSession(agentId: string): Promise<void> {
  const sessionId = agentSessionIdOf(agentId)
  const claim = CLAIMS.get(sessionId)
  if (claim === undefined) return

  if (claim.closing === undefined) {
    claim.failure = undefined
    claim.closing = claim.handle.dispose().then(
      () => {
        CLAIMS.delete(sessionId)
      },
      (error: unknown) => {
        claim.failure = error
      },
    )
  }
  await claim.closing
  if (claim.failure !== undefined) {
    claim.closing = undefined
    refuse(
      'write-not-durable',
      `agent session ${sessionId} could not be closed: ${describeFailure(claim.failure)}; it stays registered here, so a later close can still release the lease`,
    )
  }
}

/** Create the session fresh. Only the medium decides whether that is possible. */
async function createAgent(agents: AgentRegistry, sessionId: SessionId, request: AgentSessionRequest): Promise<AgentHandle> {
  try {
    return await agents.create({
      sessionId,
      ...(request.cwd === undefined ? {} : { meta: { cwd: request.cwd } }),
      ...(request.parentAgent === undefined ? {} : { parentAgent: request.parentAgent }),
      ...(request.setup === undefined ? {} : { setup: request.setup }),
      ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
    })
  } catch (error) {
    if (error instanceof SessionAlreadyExistsError)
      refuse(
        'illegal-transition',
        `agent session ${sessionId} appeared in the medium between the existence check and the create (${error.message}); a fresh create must not overwrite persisted history`,
      )
    refuse('write-not-durable', `agent session ${sessionId} could not be created: ${describeFailure(error)}`)
  }
}

/**
 * Resume the persisted session.
 *
 * This **writes** — `session/end-seed` is appended even to a balanced log — so it takes the
 * single-writer lease, and a lease conflict is named. Every other failure keeps its upstream
 * identity in the detail instead of being classified by class: the repair refusals are bare
 * `Error`s, which `instanceof` against the exported classes silently misses.
 *
 * `setup` is re-run here, and that is the point of it being a request parameter: a resumed child
 * whose composition was not replayed would come back with an empty tool registry, because nothing
 * about a scope survives the process that mounted it.
 */
async function resumeAgent(agents: AgentRegistry, sessionId: SessionId, request: AgentSessionRequest): Promise<AgentHandle> {
  try {
    return await agents.resume({
      resumeSessionId: sessionId,
      ...(request.parentAgent === undefined ? {} : { parentAgent: request.parentAgent }),
      ...(request.setup === undefined ? {} : { setup: request.setup }),
      ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
    })
  } catch (error) {
    if (error instanceof SessionAlreadyOwnedError)
      refuse(
        'concurrent-writer',
        `agent session ${sessionId} cannot be resumed (${error.message}); resume appends the repair closer, so it needs the write lease — retry after the current holder closes or is killed`,
      )
    refuse('write-not-durable', `agent session ${sessionId} could not be resumed: ${describeFailure(error)}`)
  }
}

/**
 * The stable session id one agent id resolves to.
 *
 * Derived, never supplied: the caller cannot hand in a session id of its own, and two different
 * agent ids cannot collide, because `singularity:agent:` + the raw id is injective over every JS
 * string. The prefix also keeps this namespace disjoint from the control store's
 * `singularity:control:` one, which shares the same persistence root. The JSONL backend encodes the
 * id into one path segment injectively over every JS string, so even `../` in an agent id addresses
 * a directory under the session root rather than escaping it.
 */
export function agentSessionIdOf(agentId: string): SessionId {
  if (agentId.length === 0)
    refuse('malformed-declaration', 'an agent id must be a non-empty string; it names the session that will carry the agent')
  return SessionId(`singularity:agent:${agentId}`)
}

/** One upstream failure as text, with its class name preserved for the reader. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
