/**
 * The runtime tool-execution gate and the write drain (A3 §3.3): what may still
 * run once a run has stopped being the thing that decides its own work.
 */

import type { ExecutionPhase } from '@dangosys/dsh-singularity-task'
import { message, sleep } from './helpers.ts'

/**
 * What a session bound to a run may still call once its run is no longer
 * `active`. Read-only inspection, diagnosis, the human-question tools, and the
 */
export const COORDINATION_ALLOWED: ReadonlySet<string> = new Set([
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'skill',
  'task_review_pack',
  'task_review_agent',
  'task_diagnose',
  'task_budget_extend',
  'read',
  'read_image',
  'glob',
  'grep',
  'web_fetch',
  'ask_user_question',
  'hitl_ask',
  'hitl_approve',
  'task_cancel',
  'task_proposal_read',
  'task_proposal_cancel',
  'task_ask_parent',
  'task_answer',
])

/** A tool call that was let through and has not reported its result yet. */
interface InFlightCall {
  readonly callId: string
  readonly name: string
}

/**
 * The jobs service as the drain uses it, structurally. Written as a soft
 * interface so the runtime can hand in `ctx.jobs` without this module importing
 */
export interface JobsViewEntry {
  readonly id: string
  readonly status: string
  readonly detail?: string
}

export interface JobsView {
  list(agent?: unknown): readonly JobsViewEntry[]
  kill(id: string, agent?: unknown, reason?: string): unknown
  wait(id: string, timeoutMs: number, agent?: unknown): Promise<{ status: string; detail?: string }>
}

/** The job statuses that mean the work is over — the only statuses the drain accepts as confirmed. */
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(['killed', 'completed', 'failed'])

/** The reason a drain kill carries, so a producer's log says who asked and why. */
export const DRAIN_KILL_REASON = 'task-runtime: write drain before admission closes'

/** How often the drain re-reads the in-flight set. Short: the calls it waits for usually settle in milliseconds. */
const DRAIN_POLL_MS = 5

/** What the gate decided about one call. `allow: true` means `next()`; a refusal names the phase and why the tool is not in it. */
type GateDecision = { allow: true } | { allow: false; reason: string }

interface DrainOptions {
  /** How long the whole drain may take, in milliseconds; the caller's policy, never a default here. */
  timeoutMs: number
  /**
   * The call that is asking for the drain. It is in flight by definition (it is
   * the submission or admission call itself), so counting it would wait for the
   */
  excludeCallId?: string
  /** The jobs service; absent (with `agent`) means this deployment has no managed jobs to reconcile. */
  jobs?: JobsView
  /** The owner agent a jobs call is authorized as. */
  agent?: unknown
}

export type DrainResult = { confirmed: true } | { confirmed: false; pending: string[] }

/**
 * The phase each session is in, what it has in flight, and whether it is waiting
 * on an answer. One instance per runtime; nothing here touches the store or a
 */
export class ExecutionGate {
  private readonly phases = new Map<string, ExecutionPhase | 'terminal'>()
  /** Registering by call id (not by session) because `tools/result` carries only the call id. */
  private readonly calls = new Map<string, { sessionId: string; name: string }>()
  /**
   * How many times this process wrote one session's phase by its own authority
   * ({@link setPhase}, {@link setTerminal}): the applicability token a
   */
  private readonly decisions = new Map<string, number>()
  /**
   * The sessions whose runs are waiting on an unresolved blocking question
   * (A4 §F.1). A set rather than a map of booleans: "no entry" and "not blocked"
   */
  private readonly questionBlocked = new Set<string>()

  /**
   * Move a session's phase: the runtime calls this when **it** is the authority
   * for the transition — a committed admission or submission, a settled run, an
   */
  setPhase(sessionId: string, phase: ExecutionPhase): void {
    this.decisions.set(sessionId, this.decisionToken(sessionId) + 1)
    this.phases.set(sessionId, phase)
  }

  /**
   * Mark a session's run terminal: only the allow-list runs from here, and its
   * reason says the call is late. A decision, like {@link setPhase} — it moves
   */
  setTerminal(sessionId: string): void {
    this.decisions.set(sessionId, this.decisionToken(sessionId) + 1)
    this.phases.set(sessionId, 'terminal')
    this.questionBlocked.delete(sessionId)
  }

  /**
   * How many times this process has written this session's phase by its own
   * authority; `0` for a session it has never written one for. This is the
   */
  decisionToken(sessionId: string): number {
    return this.decisions.get(sessionId) ?? 0
  }

  /**
   * Apply a phase the store implies — never one this process decided — and only
   * when it is newer than everything decided here: `token` is the
   */
  applyStorePhase(sessionId: string, phase: ExecutionPhase | 'terminal', token: number): boolean {
    if (this.decisionToken(sessionId) !== token) return false
    this.phases.set(sessionId, phase)
    if (phase === 'terminal') this.questionBlocked.delete(sessionId)
    return true
  }

  /**
   * Record that a session's run is — or is no longer — waiting on an unresolved
   * blocking question (A4 §F.1). A decision of this process about a fact this
   */
  setQuestionsBlocked(sessionId: string, blocked: boolean): void {
    this.decisions.set(sessionId, this.decisionToken(sessionId) + 1)
    if (blocked) this.questionBlocked.add(sessionId)
    else this.questionBlocked.delete(sessionId)
  }

  /**
   * Apply a blocking state the store implies — never one this process decided —
   * under the same token rule as {@link applyStorePhase}: `token` is the
   */
  applyStoreQuestionsBlocked(sessionId: string, blocked: boolean, token: number): boolean {
    if (this.decisionToken(sessionId) !== token) return false
    if (blocked) this.questionBlocked.add(sessionId)
    else this.questionBlocked.delete(sessionId)
    return true
  }

  /** Whether the run bound to this session is waiting on an unresolved blocking question (A4 §7.2's derived wait). */
  questionsBlocked(sessionId: string): boolean {
    return this.questionBlocked.has(sessionId)
  }

  /** The phase a session is under, or `undefined` when no run is bound to it (nothing is gated). */
  phaseOf(sessionId: string): ExecutionPhase | 'terminal' | undefined {
    return this.phases.get(sessionId)
  }

  /**
   * Register a call that was let through. Called for every allowed call whatever
   * its phase, because the phase can change while it runs — that in-flight write
   */
  trackAllowed(sessionId: string, callId: string, toolName: string): void {
    this.calls.set(callId, { sessionId, name: toolName })
  }

  /** The result event for a call arrived: it is no longer in flight. Unknown ids are the denied calls, and are ignored. */
  settled(callId: string): void {
    this.calls.delete(callId)
  }

  /**
   * The session's in-flight calls that count as writes: everything whose name is
   * not in {@link COORDINATION_ALLOWED}. The definition is the allow-list, not a
   */
  inFlightWrites(sessionId: string): InFlightCall[] {
    const writes: InFlightCall[] = []
    for (const [callId, call] of this.calls) {
      if (call.sessionId !== sessionId) continue
      if (COORDINATION_ALLOWED.has(call.name)) continue
      writes.push({ callId, name: call.name })
    }
    return writes
  }

  /**
   * Decide one call. A session with no phase is not bound to a run and is not
   * gated; an `active` run with no blocking question is still deciding its own
   */
  decide(sessionId: string, toolName: string): GateDecision {
    const phase = this.phases.get(sessionId)
    if (phase === undefined) return { allow: true }
    if (COORDINATION_ALLOWED.has(toolName)) return { allow: true }
    const blocked = this.questionBlocked.has(sessionId)
    if (phase === 'active' && !blocked) return { allow: true }
    const late =
      phase === 'terminal' ? ' This is a late call: the run is terminal, so only read-only coordination remains.' : ''
    const because = blocked
      ? `is waiting on an unresolved blocking question (its phase is "${phase}", unchanged: an answer releases the question, never the write gate)`
      : `is in phase "${phase}", where tools that write, spawn, or produce effects are closed`
    return {
      allow: false,
      reason:
        `the run bound to this session ${because}, so "${toolName}" is denied.` +
        `${late} Allowed in this phase: the coordination and read-only tools (${[...COORDINATION_ALLOWED].join(', ')}).`,
    }
  }

  /**
   * Wait — bounded — until this session has no in-flight write and no live
   * managed job, and say exactly what is left when the window closes. Never
   */
  async drainSession(sessionId: string, opts: DrainOptions): Promise<DrainResult> {
    const deadline = Date.now() + opts.timeoutMs
    const pending: string[] = []
    for (;;) {
      const writes = this.inFlightWrites(sessionId).filter(call => call.callId !== opts.excludeCallId)
      if (writes.length === 0) break
      if (Date.now() >= deadline) {
        pending.push(
          ...writes.map(
            call => `in-flight call "${call.name}" (${call.callId}) had not settled when the drain window closed`,
          ),
        )
        break
      }
      await sleep(DRAIN_POLL_MS)
    }
    const { jobs, agent } = opts
    if (jobs !== undefined && agent !== undefined) pending.push(...(await reconcileJobs(jobs, agent, deadline)))
    return pending.length === 0 ? { confirmed: true } : { confirmed: false, pending }
  }
}

/**
 * One write drain, wired the way every caller means it: the caller's own window,
 * the coordination call that must not be waited for, and the managed jobs — which
 */
export async function drainSession(
  gate: ExecutionGate,
  sessionId: string,
  options: { timeoutMs: number; excludeCallId?: string; jobs?: JobsView; agent?: unknown },
): Promise<DrainResult> {
  const { jobs, agent } = options
  return await gate.drainSession(sessionId, {
    timeoutMs: options.timeoutMs,
    ...(options.excludeCallId === undefined ? {} : { excludeCallId: options.excludeCallId }),
    ...(jobs === undefined || agent === undefined ? {} : { jobs, agent }),
  })
}

/**
 * Kill and confirm every non-terminal job the agent owns, within what is left of
 * the drain window. Every failure mode is a *named* entry in the returned list:
 */
async function reconcileJobs(jobs: JobsView, agent: unknown, deadline: number): Promise<string[]> {
  const pending: string[] = []
  let listed: readonly JobsViewEntry[]
  try {
    listed = jobs.list(agent)
  } catch (error) {
    return [`the jobs service could not be listed (${message(error)}), so its managed work could not be reconciled`]
  }
  for (const entry of listed) {
    const id = entry.id
    if (typeof id !== 'string' || id.length === 0) {
      pending.push(`a listed job with status "${entry.status}" names no id, so it could not be killed or waited for`)
      continue
    }
    if (TERMINAL_JOB_STATUSES.has(entry.status)) continue
    try {
      jobs.kill(id, agent, DRAIN_KILL_REASON)
    } catch (error) {
      pending.push(`job "${id}" (${entry.status}) could not be killed: ${message(error)}`)
      continue
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      pending.push(
        `job "${id}" (${entry.status}) was asked to stop but the drain window closed before it could be confirmed terminal`,
      )
      continue
    }
    try {
      const settled = await jobs.wait(id, remaining, agent)
      if (!TERMINAL_JOB_STATUSES.has(settled.status)) {
        pending.push(
          `job "${id}" is "${settled.status}"${settled.detail === undefined ? '' : ` (${settled.detail})`} after being asked to stop, which is not a terminal status`,
        )
      }
    } catch (error) {
      pending.push(`job "${id}" (${entry.status}) could not be waited for: ${message(error)}`)
    }
  }
  return pending
}
