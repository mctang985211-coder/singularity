/**
 * The runtime tool-execution gate and the write drain (A3 §3.3): what may still
 * run once a run has stopped being the thing that decides its own work.
 *
 * Why this is a module of its own: a run's phase is a promise about the store
 * (admission closed, submission handed in), and a promise about the store is
 * worthless if the worker keeps writing into the checkout after it was made. The
 * gate is that promise's other half — from the instant the phase changes, a
 * session bound to the run may only read, ask, diagnose, or cancel; everything
 * else is denied with a reason that names the phase. The seam is DSH's global
 * `tools/pre-execute` hook (a decision per call, PTC sub-calls included) plus
 * `tools/result`, which fires exactly once per execution whether it succeeded,
 * failed or was aborted; the wiring lives in the runtime, this file is the state
 * machine it wires.
 *
 * Two rules give the gate its meaning, and each is a place a plausible shortcut
 * would be wrong:
 *
 * - **Only allowed calls are tracked.** A denied call never runs, so it is never
 *   registered; its `tools/result` arrives as a no-op. Tracking denied calls
 *   would make the drain wait for work that does not exist.
 * - **Registration is unconditional of phase.** A write that was admitted while
 *   the run was `active` is *in flight* while the phase changes underneath it —
 *   that call is exactly what the drain exists to wait for. So `trackAllowed` is
 *   not "register a write", it is "this call was let through": the name decides
 *   whether it counts as a write when the drain looks.
 *
 * {@link ExecutionGate.drainSession} is the second half: it waits, bounded, for
 * this session's in-flight writes to settle (minus the coordination call that is
 * asking — `excludeCallId`, because the caller is still running by definition and
 * waiting for itself can only time out), then kills and waits for the managed
 * jobs the session started. It never assumes a stop happened: an unresolved call
 * or a job that is still not terminal when the window closes is returned *by
 * name* in `pending`, and the caller must treat that as "cannot be confirmed" —
 * the one honest input to the "no verification on an unconfirmed drain" rule.
 *
 * The phase is not stored here on its own account: the runtime moves it when the
 * store says so, and `undefined` therefore means something specific — this
 * session is not bound to a run (an env-clean helper, a reviewer session), and
 * nothing about it is gated.
 * @module @dangosys/dsh-singularity-task-runtime/gate
 */

import type { ExecutionPhase } from '@dangosys/dsh-singularity-task'

/**
 * What a session bound to a run may still call once its run is no longer
 * `active`. Read-only inspection, diagnosis, the human-question tools, and the
 * controlled cancellation of this batch: the work of *looking at* a run or
 * ending it, never of making it produce more.
 *
 * `task_cancel` is in the list because cancelling is the one write a waiting or
 * submitted run is allowed: the run has stopped deciding, and the owner may
 * still stop the tree.
 */
export const COORDINATION_ALLOWED: ReadonlySet<string> = new Set([
  'task_read',
  'task_status',
  'capability_list',
  'skill',
  'session_search',
  'session_event_read',
  'session_trace',
  'task_review_pack',
  'task_diagnose',
  'read',
  'read_image',
  'glob',
  'grep',
  'web_fetch',
  'ask_user_question',
  'hitl_ask',
  'hitl_approve',
  'task_cancel',
])

/** A tool call that was let through and has not reported its result yet. */
export interface InFlightCall {
  readonly callId: string
  readonly name: string
}

/**
 * The jobs service as the drain uses it, structurally. Written as a soft
 * interface so the runtime can hand in `ctx.jobs` without this module importing
 * a cordis service (or any harness package): `id` is the job this module kills
 * and waits on (DSH's own `JobSnapshot.id`), `status` is DSH's
 * `running | stopping | completed | killed | failed`, and the three terminal
 * ones are what "confirmed stopped" means.
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
export const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(['killed', 'completed', 'failed'])

/** The reason a drain kill carries, so a producer's log says who asked and why. */
export const DRAIN_KILL_REASON = 'task-runtime: write drain before admission closes'

/** How often the drain re-reads the in-flight set. Short: the calls it waits for usually settle in milliseconds. */
const DRAIN_POLL_MS = 5

/** What the gate decided about one call. `allow: true` means `next()`; a refusal names the phase and why the tool is not in it. */
export type GateDecision = { allow: true } | { allow: false; reason: string }

export interface DrainOptions {
  /** How long the whole drain may take, in milliseconds; the caller's policy, never a default here. */
  timeoutMs: number
  /**
   * The call that is asking for the drain. It is in flight by definition (it is
   * the submission or admission call itself), so counting it would wait for the
   * drain to finish waiting — the deadlock §3.3 records.
   */
  excludeCallId?: string
  /** The jobs service; absent (with `agent`) means this deployment has no managed jobs to reconcile. */
  jobs?: JobsView
  /** The owner agent a jobs call is authorized as. */
  agent?: unknown
}

export type DrainResult = { confirmed: true } | { confirmed: false; pending: string[] }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * The phase each session is in, and what it has in flight. One instance per
 * runtime; nothing here touches the store or a service, so the rules can be
 * tested as the pure state machine they are.
 */
export class ExecutionGate {
  private readonly phases = new Map<string, ExecutionPhase | 'terminal'>()
  /** Registering by call id (not by session) because `tools/result` carries only the call id. */
  private readonly calls = new Map<string, { sessionId: string; name: string }>()

  /** Move a session's phase; the runtime calls this when the store recorded the transition. */
  setPhase(sessionId: string, phase: ExecutionPhase): void {
    this.phases.set(sessionId, phase)
  }

  /** Mark a session's run terminal: only the allow-list runs from here, and its reason says the call is late. */
  setTerminal(sessionId: string): void {
    this.phases.set(sessionId, 'terminal')
  }

  /** The phase a session is under, or `undefined` when no run is bound to it (nothing is gated). */
  phaseOf(sessionId: string): ExecutionPhase | 'terminal' | undefined {
    return this.phases.get(sessionId)
  }

  /**
   * Register a call that was let through. Called for every allowed call whatever
   * its phase, because the phase can change while it runs — that in-flight write
   * is what `drainSession` waits for.
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
   * second list of write tools — a tool this deployment adds is a write until the
   * coordination protocol says otherwise, and the two answers cannot drift.
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
   * gated; an `active` run is still deciding its own work. Every other phase
   * allows the coordination list and denies everything else, naming the phase,
   * the refused tool, and what is still allowed.
   */
  decide(sessionId: string, toolName: string): GateDecision {
    const phase = this.phases.get(sessionId)
    if (phase === undefined || phase === 'active') return { allow: true }
    if (COORDINATION_ALLOWED.has(toolName)) return { allow: true }
    const late = phase === 'terminal' ? ' This is a late call: the run is terminal, so only read-only coordination remains.' : ''
    return {
      allow: false,
      reason:
        `the run bound to this session is in phase "${phase}", where tools that write, spawn, or produce effects are closed, so "${toolName}" is denied.` +
        `${late} Allowed in this phase: the coordination and read-only tools (${[...COORDINATION_ALLOWED].join(', ')}).`,
    }
  }

  /**
   * Wait — bounded — until this session has no in-flight write and no live
   * managed job, and say exactly what is left when the window closes. Never
   * assumes a stop: `confirmed: false` with named `pending` entries is the
   * honest answer for a call that did not settle or a job that is still not
   * terminal, and the caller must refuse verification on it (§3.3).
   *
   * Order matters: the in-flight calls first (they are the writes this process
   * can see finish), then the jobs this session started (kill, then wait for a
   * terminal status within whatever window is left). The jobs step is skipped
   * entirely when the deployment gave no service or no agent — there is nothing
   * to reconcile, which is not the same as "nothing running".
   */
  async drainSession(sessionId: string, opts: DrainOptions): Promise<DrainResult> {
    const deadline = Date.now() + opts.timeoutMs
    const pending: string[] = []
    for (;;) {
      const writes = this.inFlightWrites(sessionId).filter(call => call.callId !== opts.excludeCallId)
      if (writes.length === 0) break
      if (Date.now() >= deadline) {
        pending.push(...writes.map(call => `in-flight call "${call.name}" (${call.callId}) had not settled when the drain window closed`))
        break
      }
      await sleep(DRAIN_POLL_MS)
    }
    const { jobs, agent } = opts
    if (jobs !== undefined && agent !== undefined) pending.push(...await reconcileJobs(jobs, agent, deadline))
    return pending.length === 0 ? { confirmed: true } : { confirmed: false, pending }
  }
}

/**
 * One write drain, wired the way every caller means it: the caller's own window,
 * the coordination call that must not be waited for, and the managed jobs — which
 * are reconciled only when both the service and the agent authorizing the kills
 * are there. The rule lives in one place so the three call sites cannot drift.
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
 * a jobs call that threw, a job that could not be waited for, a job whose status
 * is still not terminal. None of them is read as "stopped".
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
      pending.push(`job "${id}" (${entry.status}) was asked to stop but the drain window closed before it could be confirmed terminal`)
      continue
    }
    try {
      const settled = await jobs.wait(id, remaining, agent)
      if (!TERMINAL_JOB_STATUSES.has(settled.status)) {
        pending.push(`job "${id}" is "${settled.status}"${settled.detail === undefined ? '' : ` (${settled.detail})`} after being asked to stop, which is not a terminal status`)
      }
    } catch (error) {
      pending.push(`job "${id}" (${entry.status}) could not be waited for: ${message(error)}`)
    }
  }
  return pending
}
