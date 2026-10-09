/**
 * The native approval seam: one ask, and the audit identity of the act it granted.
 *
 * **What the seam is, measured** (`docs/context.md` §10 and the evidence-B probe
 * `dsh-phase-b-probe/05-approval.mjs`): `ctx.approval.request(req)` puts one question to the
 * composed answerers, appends the log-only audit pair `approval/asked {id, toolName, callId?,
 * reason?}` / `approval/decided {id, outcome}` to the **asking agent's session**, and answers with
 * the closed outcome `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`. `'allowed-once'`
 * is the only grant; a missing or throwing answerer yields `'unavailable'`, and callers fail closed
 * on it. **No digest is anywhere in that pair** — `approval/asked` names a tool and a tool call,
 * never the content being decided. So the only thing this seam may be trusted for is *"a human
 * authorised this act"*: the identity recorded here is the audit identity of the act, not a
 * description of what it authorised. The content binding is the release protocol's own.
 *
 * **Why the types here are structural.** `tsconfig.json` has a `paths` entry per DSH package and no
 * entry for `dsh-user-approval`, so this build cannot resolve that package's declarations (the
 * vocabulary is a *type-only* export, so there is nothing to import at run time either). Rather than
 * re-declare the closed outcome set — a second copy of a vocabulary nothing keeps in step — the
 * outcome is read as a string and compared against the one outcome this stack acts on,
 * {@link APPROVAL_GRANT}; anything else, including an outcome added upstream later, is not a grant.
 * The request shape below is exactly the members measured on `approval/asked` plus the live agent.
 *
 * **Why the id is read from the session feed.** The `ApprovalRequestId` is service-issued inside
 * `request()` and never returned, so the session log is the only place it exists. `session/event` is
 * the post-commit append feed; measured in this tree, the `approval/asked` delivery arrives before
 * `request()` resolves, because the service appends the ask and only then awaits the answerers. This
 * module therefore subscribes first and closes the subscription when the ask settles. Every
 * synchronous session event reader in this build is deprecated ("new calls are prohibited"), so none
 * is used here.
 *
 * **Attribution is exact or absent.** A grant is reported with its `approvalId` only when the ask's
 * window holds exactly one `approval/asked` for the asking session. Zero (a log that did not record
 * it) or two (a deployment asking twice concurrently on one session) means the id on the table might
 * belong to somebody else's question, and an unattributable grant must be refused by the caller
 * rather than guessed at.
 *
 * **A missing seam is refused at load.** A cordis service whose plugin was mounted without its
 * `inject` dependency is silently `undefined`, so {@link assertApprovalSeams} names every absent
 * seam instead of letting an `undefined` be met mid-ask. There is no default and no fallback: a
 * deployment that composed no approval seam cannot record an approval at all.
 *
 * @module singularity-core/runtime/approval
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { refuse } from '../protocol/refusal.ts'

/** The only outcome that grants anything. Every other answer — and every failure — is not consent. */
export const APPROVAL_GRANT = 'allowed-once'

/** The one service method this module drives. Structural, so a spec holds a stub and a probe the real service. */
interface ApprovalServiceLike {
  request(ask: ApprovalAsk): Promise<string>
}

/**
 * The post-commit append feed (`ctx.on('session/event', listener)`), narrowed to what this module
 * subscribes to. A cordis `Context` already has this signature, so a deployment composes its seams
 * as `{ approval: ctx.approval, feed: ctx }`.
 */
interface SessionEventFeed {
  on(name: 'session/event', listener: (session: Session, event: SessionEvent) => void): () => void
}

/**
 * Every seam this module drives. Both are optional because that is how an unmounted cordis service
 * actually looks: the property is simply not there.
 */
export interface ApprovalSeams {
  /** `ctx.approval`: the native service that puts the question and logs the audit pair. */
  readonly approval?: ApprovalServiceLike | undefined
  /** `ctx` itself: its `session/event` append feed is how the service-issued audit id is read. */
  readonly feed?: SessionEventFeed | undefined
}

/**
 * One ask: who asks, and what the question is about. This is also the service's own request shape —
 * one type, not two, because a second identical interface is a second thing to keep in step.
 * `callId` is a plain string here because its brand lives in a package this build cannot resolve
 * (`tsconfig.json` has no path entry for `dsh-user-approval`); the value passed at run time is the
 * real tool call id.
 */
export interface ApprovalAsk {
  /** The live agent on whose behalf the question is asked. Its session carries the audit pair. */
  readonly agent: Agent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of why it is asking. */
  readonly reason?: string
  /** Withdraws the question: it settles `'cancelled'` and a late answer is discarded. */
  readonly signal?: AbortSignal
}

/** What one ask produced: the outcome as the service decided it, and the audit id when attributable. */
interface ApprovalAttempt {
  readonly outcome: string
  /**
   * The `approval/asked` id this ask committed. Absent when the window did not hold exactly one ask
   * for this session — and a grant whose audit identity is unknown is not usable as an approval.
   */
  readonly approvalId?: string
}

/**
 * Refuse at load when a seam this module drives is missing, naming **each** absent one.
 *
 * The feed is listed as a seam because it is the only way the audit id becomes readable: a
 * deployment that holds the service but not the feed could ask, and then be unable to say which
 * recorded question it rested on. That is the failure this check moves to load time.
 */
export function assertApprovalSeams(seams: ApprovalSeams): void {
  requiredSeams(seams)
}

/** The check `assertApprovalSeams` performs, narrowed for the ask below. */
function requiredSeams(seams: ApprovalSeams): { readonly approval: ApprovalServiceLike; readonly feed: SessionEventFeed } {
  const absent = [
    ...(seams.approval === undefined || seams.approval === null ? ['ctx.approval'] : []),
    ...(seams.feed === undefined || seams.feed === null ? ["ctx.on('session/event')"] : []),
  ]
  if (absent.length > 0)
    refuse(
      'malformed-declaration',
      `the native approval seams this module drives are absent: ${absent.join(', ')}; the approval service answers the question and the append feed carries its audit id, so without both a grant could be obtained but not identified`,
    )
  return seams as { readonly approval: ApprovalServiceLike; readonly feed: SessionEventFeed }
}

/**
 * The `approval/asked` id one session event carries, or `undefined` for every other event.
 *
 * The pair's payload type belongs to `dsh-user-approval`, which this build cannot resolve (see the
 * module note), so the shape is read structurally — `{ id, toolName, callId?, reason? }` — and an
 * id that is not a non-empty string is treated as no id at all.
 */
function askedIdOf(event: SessionEvent): string | undefined {
  if ((event.type as string) !== 'approval/asked') return undefined
  const data = event.data as { readonly id?: unknown }
  return typeof data.id === 'string' && data.id.length > 0 ? data.id : undefined
}

/**
 * Ask the composed answerers, and report what they decided with the audit id of the question.
 *
 * The subscription is closed when the ask settles, including when it rejects. A rejection is **not**
 * turned into an outcome here: only the service decides outcomes, and the caller must distinguish
 * "the answerers said no" from "the seam failed" when it decides what to do next.
 */
export async function askForApproval(seams: ApprovalSeams, ask: ApprovalAsk): Promise<ApprovalAttempt> {
  const { approval, feed } = requiredSeams(seams)
  const sessionId = ask.agent.session.id
  const asked: string[] = []
  const off = feed.on('session/event', (session, event) => {
    // The feed is scope-filtered but not session-filtered: a deployment may drive many agents on one
    // context, so the window is narrowed to the session the audit pair lands on.
    if (session.id !== sessionId) return
    const id = askedIdOf(event)
    if (id !== undefined) asked.push(id)
  })

  try {
    const outcome = await approval.request({
      agent: ask.agent,
      toolName: ask.toolName,
      ...(ask.callId === undefined ? {} : { callId: ask.callId }),
      ...(ask.reason === undefined ? {} : { reason: ask.reason }),
      ...(ask.signal === undefined ? {} : { signal: ask.signal }),
    })
    const [only] = asked
    return asked.length === 1 && only !== undefined ? { outcome, approvalId: only } : { outcome }
  } catch (error) {
    // A rejection is not an outcome: the service rejects when no turn is open or when either audit
    // append cannot commit, and both mean no decision was recorded. Upstream throws a bare `Error`
    // for both, so nothing here classifies them — the upstream text is preserved instead.
    refuse(
      'write-not-durable',
      `the native approval ask did not settle: ${describe(error)}; an ask rejects when no turn is open or when either audit append cannot commit, and a question that was never answered is not an approval`,
    )
  } finally {
    off()
  }
}

/** One upstream failure as text, with its class name preserved for the reader. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
