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
 * store says so — through {@link ExecutionGate.applyStorePhase}, so a value a
 * read handed back before a decision of this process landed cannot move the
 * phase back — and `undefined` therefore means something specific: this session
 * is not bound to a run (an env-clean helper, a reviewer session), and nothing
 * about it is gated.
 *
 * **The question block (A4 §F.1, §7.2).** One more per-session fact lives here:
 * whether the session's run is waiting on an unresolved blocking question. It is
 * *not* a phase — the store keeps no such state and the run's own main phase is
 * unchanged by asking — so it is derived from the question facts
 * (`blockingQuestionsOf`) at the four moments those facts can change (after a
 * blocking ask, after a resolving answer, when the run the question was addressed
 * to settles, and on recovery) and pushed in through
 * {@link ExecutionGate.setQuestionsBlocked}. What it does is one-way on purpose:
 * a blocked session is refused everything the coordination list does not name —
 * *including* the writes `active` would have admitted — while nothing about it
 * ever opens a gate. A `waiting_children` parent that answers its child stays in
 * `waiting_children`; the answer releases the child's block, never the parent's
 * write gate, and `active` with blocking questions is a wait, not a licence.
 * @module @dangosys/dsh-singularity-task-runtime/gate
 */

import type { ExecutionPhase } from '@dangosys/dsh-singularity-task'

/**
 * What a session bound to a run may still call once its run is no longer
 * `active`. Read-only inspection, diagnosis, the human-question tools, and the
 * controlled cancellation of this batch: the work of *looking at* a run or
 * ending it, never of making it produce more. `context_read` is the one
 * history/reference reader here: the raw cross-session tools it replaced
 * (`session_event_read` and its siblings) are sealed off every runtime-owned
 * agent by the execution guard, so they have no phase to be allowed in.
 *
 * `task_cancel` is in the list because cancelling is the one write a waiting or
 * submitted run is allowed: the run has stopped deciding, and the owner may
 * still stop the tree.
 *
 * The proposal tools follow the same categories (T2/T3). `task_proposal_read`
 * reads a saved proposal and `task_proposal_cancel` withdraws the batch its own
 * session proposed: they are the looking-at and the ending of what this run
 * already asked for, exactly the work `task_read` and `task_cancel` do.
 * `task_proposal_continue` is deliberately **not** here: it can admit a batch,
 * which is the same effect `task_decompose` has, so it is a write in every
 * non-active phase — a run that has stopped deciding its own work does not get
 * to turn a proposal into tasks.
 *
 * The two question tools (A4 §F.1) are coordination in the plainest sense: a
 * child asking its direct parent is the one effect still admitted while its own
 * run is blocked on a question, and a parent answering a child is the one effect
 * a `waiting_children` parent may still produce. Neither makes anything else
 * writable — answering is not a phase change, and a blocked run keeps its block
 * until the answer that resolves it.
 */
export const COORDINATION_ALLOWED: ReadonlySet<string> = new Set([
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'skill',
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
  'task_proposal_read',
  'task_proposal_cancel',
  'task_ask_parent',
  'task_answer',
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
 * The phase each session is in, what it has in flight, and whether it is waiting
 * on an answer. One instance per runtime; nothing here touches the store or a
 * service, so the rules can be tested as the pure state machine they are.
 */
export class ExecutionGate {
  private readonly phases = new Map<string, ExecutionPhase | 'terminal'>()
  /** Registering by call id (not by session) because `tools/result` carries only the call id. */
  private readonly calls = new Map<string, { sessionId: string; name: string }>()
  /**
   * How many times this process wrote one session's phase by its own authority
   * ({@link setPhase}, {@link setTerminal}): the applicability token a
   * store-derived phase is checked against.
   */
  private readonly decisions = new Map<string, number>()
  /**
   * The sessions whose runs are waiting on an unresolved blocking question
   * (A4 §F.1). A set rather than a map of booleans: "no entry" and "not blocked"
   * are the same fact, and a cleared session must not leave a stale value to be
   * read back. Nothing here is persisted or projected — the store's question
   * facts are the durable state, and this is the live process's handle on them.
   */
  private readonly questionBlocked = new Set<string>()

  /**
   * Move a session's phase: the runtime calls this when **it** is the authority
   * for the transition — a committed admission or submission, a settled run, an
   * unload, the binding of a session to its own run. This is one of the two
   * writers that count as a decision ({@link decisionToken}); a phase that only
   * the *store* implies goes through {@link applyStorePhase} instead, and does
   * not count as one.
   */
  setPhase(sessionId: string, phase: ExecutionPhase): void {
    this.decisions.set(sessionId, this.decisionToken(sessionId) + 1)
    this.phases.set(sessionId, phase)
  }

  /**
   * Mark a session's run terminal: only the allow-list runs from here, and its
   * reason says the call is late. A decision, like {@link setPhase} — it moves
   * the phase because this process knows the run is over, not because a read of
   * the store implied it.
   *
   * The question block goes with it: an open question requires *both* runs to be
   * running, so a run this process just made terminal is blocked by nothing —
   * leaving the flag set would make the refusal name a wait that no longer
   * exists.
   */
  setTerminal(sessionId: string): void {
    this.decisions.set(sessionId, this.decisionToken(sessionId) + 1)
    this.phases.set(sessionId, 'terminal')
    this.questionBlocked.delete(sessionId)
  }

  /**
   * How many times this process has written this session's phase by its own
   * authority; `0` for a session it has never written one for. This is the
   * applicability token for a phase read out of the store: take it *before* the
   * read, hand it back with the value ({@link applyStorePhase}).
   *
   * What it answers is not "is this value current" — a second read would race
   * the first exactly as it did — but "did anything of ours decide this session
   * while the read was in flight". That is the only thing that can make a value
   * the store returned older than the gate: the read happened, the store
   * recorded a decision of ours, and the value the read handed back predates it.
   */
  decisionToken(sessionId: string): number {
    return this.decisions.get(sessionId) ?? 0
  }

  /**
   * Apply a phase the store implies — never one this process decided — and only
   * when it is newer than everything decided here: `token` is the
   * {@link decisionToken} taken before the read that produced `phase`, and a
   * count that no longer matches means a decision landed while that read was in
   * flight. The value is then older than the gate's, and it is dropped; the
   * return says which of the two happened.
   *
   * Two trajectories reach a store-derived phase that is too old, and only one
   * of them is this token's:
   *
   * - a read that **straddled** a decision — the store returned the old record,
   *   and the decision landed before the value could be applied — is what this
   *   token refuses: the decision is on the record by then, so the count moved
   *   and the value is dropped. Applying it would re-open a gate a settled run
   *   had closed, and no other guard can see it, because the wait was inside the
   *   read and the store is already up to date when the value arrives.
   * - a read taken **inside a window whose decision is in effect but not yet
   *   persisted** (a cancellation raising its barrier before the store records
   *   it) cannot be refused by this token: the read starts *after* the decision,
   *   so the count it took is current, and the value is old only because the
   *   store's write has not happened yet. That window belongs to the caller,
   *   which refuses it before calling this — the token covers a read that
   *   straddled a decision, never one that raced a write.
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
   * process just wrote (the ask it committed, the answer that released one, the
   * addressee's own settlement that ended every question addressed to it), so it
   * counts as one exactly as {@link setPhase} does; a value the *store* implies
   * goes through {@link applyStoreQuestionsBlocked}.
   *
   * `false` is not "probably unblocked": the caller is stating the derivation it
   * just took from the store's question facts (`blockingQuestionsOf`), which is
   * what makes a second blocking question keep the session blocked after the
   * first is answered.
   */
  setQuestionsBlocked(sessionId: string, blocked: boolean): void {
    this.decisions.set(sessionId, this.decisionToken(sessionId) + 1)
    if (blocked) this.questionBlocked.add(sessionId)
    else this.questionBlocked.delete(sessionId)
  }

  /**
   * Apply a blocking state the store implies — never one this process decided —
   * under the same token rule as {@link applyStorePhase}: `token` is the
   * {@link decisionToken} taken before the read that produced it, and a value
   * the gate has moved past is dropped rather than applied. The return says
   * which of the two happened.
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
   * gated; an `active` run with no blocking question is still deciding its own
   * work. Every other state allows the coordination list and denies everything
   * else, naming what holds the session — the phase, or the question it waits on
   * — the refused tool, and what is still allowed.
   *
   * The two refusals are one decision with two names because a caller has to be
   * able to tell them apart: `active` plus a blocking question is *not* "the
   * phase closed writes", it is "this run is waiting for an answer", and an
   * answer (not a phase change) is what ends it. Both are computed after the
   * allow-list, so the question tools and the reads answer in either state.
   */
  decide(sessionId: string, toolName: string): GateDecision {
    const phase = this.phases.get(sessionId)
    if (phase === undefined) return { allow: true }
    if (COORDINATION_ALLOWED.has(toolName)) return { allow: true }
    const blocked = this.questionBlocked.has(sessionId)
    if (phase === 'active' && !blocked) return { allow: true }
    const late = phase === 'terminal' ? ' This is a late call: the run is terminal, so only read-only coordination remains.' : ''
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
