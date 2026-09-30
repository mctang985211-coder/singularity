/**
 * The automatic trigger (A5): a review that settled **failed** is accepted for
 * diagnosis on its own, under the store's own review-agent allowance.
 *
 * Two moments scan the store for failed review sources, and both run this same
 * scan:
 *
 * - a terminal review was just recorded — the runtime tells the deployment
 *   through `taskRuntime.registerTerminalReviewListener` *after* the record is
 *   durable and never awaits what the listener does with it, so the settlement
 *   of the run is not the reviewer's to hold up;
 * - a graph was explicitly activated (`graphs/selected`, emitted by the graph
 *   registry after its recovery barrier) — what a process that booted over a
 *   store with failed reviews scans, and what retries a source the first trigger
 *   had to skip.
 *
 * The scan decides per source and in this order:
 *
 * 1. **Dedupe first.** A source that already has an attempt is read rather than
 *    reviewed again, and the attempt it reads is the source's *newest* one: an
 *    older settled attempt never hides a later open one — a key claimed and
 *    started by a process that died is exactly what has to be recovered. The
 *    automatic scan invents nothing: when the newest attempt is still open, the
 *    request this scan issues *is* that attempt's own identity (its key and its
 *    focus), so an attempt an explicit call named is answered with itself
 *    instead of being refused for a focus this scan made up. Whether an open
 *    attempt really is in flight, or one a process died holding, is the ledger's
 *    decision and not this pre-read's: the admission records the terminal fact
 *    such an attempt never got (A5's crash recovery), or answers with an identity
 *    that really is running. Either way the recovery is named in this scan's own
 *    line. A settled attempt is not reviewed again; its stored diagnosis is
 *    relayed to the source's business coordinator with the same message id.
 * 2. **Then the allowance.** A source with no attempt behind it goes through the
 *    ledger's own admission: the serial region decides, the claim lands before
 *    any reviewer exists, and the store's allowance is read only when an attempt
 *    would really start. An exhausted store is skipped *by name*, with zero
 *    claim and zero spawn — and a later scan may retry the same source once there
 *    is room, because nothing was written for it.
 * 3. **Then the reviewer.** The attempt is one and the same as an explicit
 *    call's (`review-agent-run.ts`): the pack, the spawn and the
 *    one terminal fact. Its parent is the graph's root session — a review agent
 *    is a runtime act of the root agent — so a store whose root session is not
 *    live is skipped by name rather than spawned from somewhere invented.
 *
 * Success is never a trigger: only `outcome === 'failed'` is scanned, so a
 * verified review spawns nothing however the scan is entered.
 * @module @dangosys/dsh-singularity-agent/review-agent-scan
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId, type ReviewRecord, type TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { TerminalReviewFact } from '@dangosys/dsh-singularity-task-runtime'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { readReviewAgentAttempts, type ReviewAgentAttempt, type ReviewAgentSource } from './review-agent-ledger.ts'
import { recordedDiagnosis, runReviewAgentAttempt, sourceRef, type ReviewParentAgent } from './review-agent-run.ts'
import { reviewForSource } from './tools/task-review-pack.ts'

/** The prefix `rootTaskStoreId` writes; see {@link rootSessionOfStore}. */
const STORE_PREFIX = 'sg-t-'

/**
 * The graph root session one root task store belongs to, read back from the
 * store id `rootTaskStoreId` derives it from — or nothing when the id was not
 * derived that way. It is re-checked rather than trusted: an id this scan cannot
 * read back is a store it must not spawn a reviewer for.
 */
export function rootSessionOfStore(storeId: string): string | undefined {
  if (!storeId.startsWith(STORE_PREFIX)) return undefined
  const rootSessionId = storeId.slice(STORE_PREFIX.length)
  return rootSessionId.length === 0 ? undefined : rootSessionId
}

/** What one source's automatic acceptance ended as. */
export interface ReviewScanEntry {
  readonly source: ReviewAgentSource
  /**
   * `started` — this scan admitted and spawned the source's attempt;
   * `existing` — the source already had an attempt; no reviewer was started;
   * `skipped` — nothing was claimed or spawned, and {@link reason} says why;
   * `failed` — the attempt was admitted and its reviewer did not finish it.
   */
  readonly result: 'started' | 'existing' | 'skipped' | 'failed'
  /** The attempt's reviewer session, when the source has one. */
  readonly sessionId?: string
  /** Why nothing was started, what ended the attempt, or why its diagnosis could not be delivered. */
  readonly reason?: string
}

/** What one scan of one store found and did. */
export interface ReviewScanReport {
  readonly storeId: string
  readonly entries: readonly ReviewScanEntry[]
}

export interface ReviewScanOptions {
  /** Scan only this source (the terminal-review trigger names one); absent scans every failed source of the store. */
  readonly source?: ReviewAgentSource
  /** Where the scan's lines go — named skips included; absent says nothing. */
  readonly log?: (line: string) => void
}

/** Whether two sources are the same source. */
function sameSource(left: ReviewAgentSource, right: ReviewAgentSource): boolean {
  return left.taskId === right.taskId && left.runId === right.runId
}

/**
 * Every source of the store whose review settled `failed`, in the order the
 * records were written — the exact source a review agent exists for, derived
 * from the record's own run (`null` for a review that carries none) and never
 * from "the latest review".
 */
function failedSourcesOf(snapshot: TaskSnapshot): ReviewAgentSource[] {
  return snapshot.reviews
    .filter((review: ReviewRecord) => review.outcome === 'failed')
    .map(review => ({ taskId: review.taskId, runId: review.runId ?? null }))
}

/** The relay of the store's root session, when this process holds it live. */
function rootAgentOf(ctx: Context, storeId: string): { sessionId: string; agent: ReviewParentAgent } | undefined {
  const sessionId = rootSessionOfStore(storeId)
  if (sessionId === undefined) return undefined
  const registry = optionalService<{ get(id: string): ReviewParentAgent | undefined }>(ctx, 'agents')
  const agent = registry?.get(sessionId)
  return agent === undefined ? undefined : { sessionId, agent }
}

/** Relay the stored diagnosis to the run that delegated this source; the Session deduplicates its identity. */
async function deliverDiagnosis(
  ctx: Context,
  storeId: string,
  source: ReviewAgentSource,
  reviewerSessionId: string,
  log?: (line: string) => void,
): Promise<string | undefined> {
  try {
    const snapshot: TaskSnapshot = await ctx.task.snapshotIn(storeId)
    const diagnosis = recordedDiagnosis(snapshot, reviewerSessionId)
    if (diagnosis === undefined) return
    const task = snapshot.tasks.find(item => item.taskId === source.taskId)!
    let targetSessionId: string
    if (task.parentTaskId === undefined) {
      targetSessionId = rootSessionOfStore(storeId)!
    } else {
      const sourceRun = snapshot.runs.find(run => run.runId === source.runId)
      const parent = source.runId === null
        ? snapshot.runs.find(run => run.taskId === task.parentTaskId
          && run.batches?.some(batch => batch.memberTaskIds.includes(task.taskId)))
        : snapshot.runs.find(run => run.runId === sourceRun?.parentRunId)
      if (parent === undefined || parent.taskId !== task.parentTaskId) {
        throw new Error(`the source's delegating run for parent task ${task.parentTaskId} is not recorded`)
      }
      targetSessionId = parent.sessionId
    }
    const text = [
      `Review diagnosis ${diagnosis.diagnosisId} for failed source ${sourceRef(source)} [${diagnosis.confidence}].`,
      `Observed failure: ${diagnosis.observedFailure}`,
      `Conclusion / next action: ${diagnosis.localizedCause}`,
      `Original review: ${diagnosis.reviewRefs.join(', ')}; evidence: ${diagnosis.evidenceRefs.join(', ') || 'none recorded'}.`,
      'Read your current task/run state before acting. A diagnosis changes no task state or authority; it grants no task_recover or evolution tool.',
    ].join('\n')
    const delivery = await ctx.agentRuntime.ensureAgentMessageDelivered({
      messageId: `m-diagnosis-${diagnosis.diagnosisId}`,
      senderSessionId: SessionId(reviewerSessionId),
      targetSessionId: SessionId(targetSessionId),
      text,
    })
    log?.(`review agent: diagnosis ${diagnosis.diagnosisId} to coordinator session ${targetSessionId}: ${delivery.status}`)
    if (delivery.status === 'unavailable') {
      return `diagnosis ${diagnosis.diagnosisId} recorded but coordinator session ${targetSessionId} is unavailable; the next activation retries delivery`
    }
  } catch (error) {
    const reason = `diagnosis recorded but not delivered (${error instanceof Error ? error.message : String(error)}); the next activation retries delivery`
    log?.(`review agent: source ${sourceRef(source)} ${reason}`)
    return reason
  }
}

/**
 * Scan one root task store for failed review sources and accept each under the
 * store's allowance (see the module header for the order).
 *
 * Never throws for the work it does: a store it cannot read, a source it cannot
 * accept and a reviewer that failed all come back as entries (and as log lines
 * when a `log` is given), because every caller of this scan is a trigger — a
 * settlement or an activation — that must not take a store down with a review.
 */
export async function scanFailedReviewSources(
  ctx: Context,
  storeId: string,
  options: ReviewScanOptions = {},
): Promise<ReviewScanReport> {
  const { log } = options
  const entries: ReviewScanEntry[] = []
  const report = (): ReviewScanReport => ({ storeId, entries })
  let snapshot: TaskSnapshot
  try {
    snapshot = await ctx.task.snapshotIn(storeId)
  } catch (error) {
    log?.(`review agent: store ${storeId} could not be read (${error instanceof Error ? error.message : String(error)}); nothing was scanned`)
    return report()
  }
  const failed = failedSourcesOf(snapshot)
  const targets = options.source === undefined ? failed : failed.filter(source => sameSource(source, options.source!))
  if (targets.length === 0) return report()

  const root = rootAgentOf(ctx, storeId)
  const attempts = await readReviewAgentAttempts(storeId)
  for (const source of targets) {
    const mine = attempts.filter(attempt => sameSource(attempt.source, source))
    // The attempt this scan answers with: the source's newest one still open,
    // else its newest at all. An older settled attempt never hides a later open
    // one — an open attempt whose row a dead process left behind is what the
    // admission below has to recover.
    const open = mine.filter(attempt => attempt.settlement === undefined).at(-1)
    const existing = open ?? mine.at(-1)
    // Every attempt of this source is settled: read the newest one and review
    // nothing. An *open* attempt is not skipped here — whether it is dead (its
    // process is gone) or really in flight is the ledger's decision, not this
    // pre-read's.
    if (existing !== undefined && open === undefined) {
      const reason = await deliverDiagnosis(ctx, storeId, source, existing.sessionId, log)
      entries.push({ source, result: 'existing', sessionId: existing.sessionId, ...(reason === undefined ? {} : { reason }) })
      log?.(`review agent: source ${sourceRef(source)} already has an attempt (session ${existing.sessionId}, ${existing.settlement!.status}) — read, nothing started`)
      continue
    }
    if (root === undefined) {
      const reason = `the graph's root session for store ${storeId} is not live, so no reviewer could be started`
      entries.push({ source, result: 'skipped', reason })
      log?.(`review agent: source ${sourceRef(source)} skipped — ${reason}; no claim, no reviewer`)
      continue
    }
    const review = reviewForSource(snapshot, source)
    if (review === undefined) {
      const reason = 'the review record could not be read back'
      entries.push({ source, result: 'skipped', reason })
      log?.(`review agent: source ${sourceRef(source)} skipped — ${reason}; no claim, no reviewer`)
      continue
    }
    let outcome: Awaited<ReturnType<typeof runReviewAgentAttempt>>
    try {
      outcome = await runReviewAgentAttempt({
        ctx,
        storeId,
        source,
        review,
        parent: root.agent,
        actor: root.sessionId,
        // The request this scan issues is the attempt's own identity when the
        // source has one — its key and its focus — so the ledger answers with
        // that attempt (or recovers it) instead of refusing a default this scan
        // invented. Only a source with no attempt at all is asked for as the
        // default: no key, no focus.
        requestKey: existing === undefined ? null : existing.requestKey,
        reason: existing === undefined ? null : existing.reason,
      })
    } catch (error) {
      const reason = `the review attempt failed: ${error instanceof Error ? error.message : String(error)}`
      entries.push({ source, result: 'failed', reason })
      log?.(`review agent: source ${sourceRef(source)} failed — ${reason}`)
      continue
    }
    switch (outcome.kind) {
      case 'recorded': {
        const reason = await deliverDiagnosis(ctx, storeId, source, outcome.sessionId, log)
        entries.push({ source, result: 'started', sessionId: outcome.sessionId, ...(reason === undefined ? {} : { reason }) })
        log?.(`review agent: source ${sourceRef(source)} accepted — reviewer session ${outcome.sessionId} started`)
        break
      }
      case 'reuse':
      case 'in-flight': {
        // Another admission owns this source's attempt: the ledgers' decision is
        // what stands, and nothing was spawned here. What it decided is named —
        // including the recovery of an attempt whose process is gone, which is a
        // fact an operator reading this line has to see.
        const deliveryReason = outcome.kind === 'reuse'
          ? await deliverDiagnosis(ctx, storeId, source, outcome.attempt.sessionId, log)
          : undefined
        const reason = [recoveryReason(outcome.recovered), deliveryReason].filter(part => part !== undefined).join('; ') || undefined
        entries.push({
          source,
          result: 'existing',
          sessionId: outcome.attempt.sessionId,
          ...(reason === undefined ? {} : { reason }),
        })
        log?.(
          reason === undefined
            ? `review agent: source ${sourceRef(source)} is claimed already (session ${outcome.attempt.sessionId}) — read, nothing started`
            : `review agent: source ${sourceRef(source)} — ${reason} (session ${outcome.attempt.sessionId}); nothing started`,
        )
        break
      }
      case 'refused': {
        const reason = refusalReason(outcome.plan.code, outcome.plan.budget)
        const recovered = recoveryReason(outcome.recovered)
        entries.push({ source, result: 'skipped', reason: recovered === undefined ? reason : `${reason} — ${recovered}` })
        log?.(
          `review agent: source ${sourceRef(source)} skipped — ${reason}; no claim, no reviewer` +
          `${recovered === undefined ? '' : ` (${recovered})`}`,
        )
        break
      }
      case 'spawn-failed':
      case 'unrecorded':
      case 'no-diagnosis':
        // A reviewer that produced no diagnosis is reported as a failed
        // attempt with the reason named — never as a source that was reviewed.
        entries.push({ source, result: 'failed', sessionId: outcome.sessionId, reason: outcome.failure })
        log?.(`review agent: source ${sourceRef(source)} accepted, but the reviewer did not finish — ${outcome.failure} (session ${outcome.sessionId})`)
        break
    }
  }
  return report()
}

/** How one refusal reads in the scan's line, named the way the ledger refused. */
function refusalReason(code: 'request-key-conflict' | 'request-key-required' | 'budget-exhausted', budget: { used: number; max: number }): string {
  if (code === 'budget-exhausted') return `budget exhausted: the store's review allowance is spent (${budget.used}/${budget.max})`
  if (code === 'request-key-required') return 'the source was already reviewed and this scan names no key'
  return 'the source already has an attempt with a different focus'
}

/**
 * How the recovery one decision performed reads in the scan's own words — the
 * dead attempt the ledger settled on this call — or nothing when this decision
 * recovered none. A recovery is a fact an operator reading the scan has to see:
 * without it, a source whose reviewer died looks like one that was reviewed.
 */
function recoveryReason(recovered: readonly ReviewAgentAttempt[]): string | undefined {
  const attempt = recovered[0]
  if (attempt === undefined) return undefined
  const status = attempt.settlement?.status ?? 'interrupted'
  const note = attempt.settlement?.note === undefined ? '' : `: ${attempt.settlement.note}`
  return `the attempt found open with no process running it (session ${attempt.sessionId}) was recorded ${status}${note}`
}

/** The warning channel the plugin has, when the deployment mounted a logger. */
function softWarn(ctx: Context): (line: string) => void {
  const logger = (ctx as { logger?: (name: string) => { warn(format: string): void } }).logger
  return line => logger?.('singularity-agent').warn(line)
}

/**
 * Install the two triggers of the automatic scan on this deployment's context:
 * the runtime's terminal-review door (a review that settled `failed`) and the
 * graph registry's activation event (a store scanned on explicit activation).
 *
 * The listeners do their work off the caller's path: both start the scan and
 * return immediately, and a scan that fails is reported on the log rather than
 * thrown into the settlement or the activation that woke it.
 * @param ctx - the deployment's context, with the runtime and the graph registry.
 * @param options - where the scan's lines go; the plugin's own logger by default.
 * @returns a disposer that removes both listeners.
 */
export function installReviewAgentAutoTrigger(ctx: Context, options: { log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? softWarn(ctx)
  const background = (work: () => Promise<unknown>): void => {
    void work().catch(error => {
      log(`review agent: the scan could not run (${error instanceof Error ? error.message : String(error)})`)
    })
  }
  const disposers: (() => void)[] = [
    ctx.taskRuntime.registerTerminalReviewListener((fact: TerminalReviewFact) => {
      // A success is not a trigger: only a failed review is accepted on its own.
      if (fact.outcome !== 'failed') return
      background(() => scanFailedReviewSources(ctx, fact.storeId, {
        source: { taskId: fact.taskId, runId: fact.runId },
        log,
      }))
    }),
    ctx.on('graphs/selected', graph => {
      background(() => scanFailedReviewSources(ctx, rootTaskStoreId(graph.rootSessionId), { log }))
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
