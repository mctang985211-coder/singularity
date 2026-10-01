/** The automatic trigger (A5): a terminal review — failed, or verified under the deployment's `autoReview: 'all'` — is accepted for diagnosis on its own, under the store's own review-agent allowance. @module @dangosys/dsh-singularity-agent/review-agent-scan */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId, type ReviewRecord, type TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { TerminalReviewFact } from '@dangosys/dsh-singularity-task-runtime'
import { warnLine } from '../log.ts'
import { liveRootAgentOf, ownerSessionOfStore, sameSource } from './identity.ts'
import { readReviewAgentAttempts, type ReviewAgentAttempt, type ReviewAgentRefusalCode, type ReviewAgentSource } from './ledger.ts'
import { recordedDiagnosis, runReviewAgentAttempt, sourceRef } from './review-run.ts'
import { supervisionSettings, type AutoReviewMode } from './supervision.ts'
import { backgroundScan, installGraphSelectedScan } from './trigger.ts'
import { reviewForSource } from '../tools/task-review-pack.ts'

/** What one source's automatic acceptance ended as. */
export interface ReviewScanEntry {
  readonly source: ReviewAgentSource
  /** `started` — this scan admitted and spawned the source's attempt; `existing` — the source already had an attempt; no reviewer was started; `skipped` — nothing was claimed or spawned, and {@link reason} says why; */
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
  /** Scan only this source (the terminal-review trigger names one); absent scans every accepted source of the store. */
  readonly source?: ReviewAgentSource
  /** Which terminal reviews this scan accepts; absent reads the deployment's `supervision.autoReview` (`all` by default). */
  readonly autoReview?: AutoReviewMode
  /** Where the scan's lines go — named skips included; absent says nothing. */
  readonly log?: (line: string) => void
}

/** Every source of the store whose review this mode accepts, in the order the records were written — `all` takes failed and verified records, `failed` only failures, `off` none. */
function acceptedSourcesOf(snapshot: TaskSnapshot, mode: AutoReviewMode): ReviewAgentSource[] {
  if (mode === 'off') return []
  return snapshot.reviews
    .filter((review: ReviewRecord) => review.outcome === 'failed' || (mode === 'all' && review.outcome === 'verified'))
    .map(review => ({ taskId: review.taskId, runId: review.runId ?? null }))
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
      targetSessionId = ownerSessionOfStore(storeId)!
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
      `Review diagnosis ${diagnosis.diagnosisId} for review source ${sourceRef(source)} [${diagnosis.confidence}].`,
      `Observation: ${diagnosis.observedFailure}`,
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

/** Scan one root task store for the reviews its `autoReview` mode accepts and admit each under the store's allowance (see the module header for the order). */
export async function scanFailedReviewSources(
  ctx: Context,
  storeId: string,
  options: ReviewScanOptions = {},
): Promise<ReviewScanReport> {
  const { log } = options
  const mode = options.autoReview ?? supervisionSettings().autoReview
  const entries: ReviewScanEntry[] = []
  const report = (): ReviewScanReport => ({ storeId, entries })
  if (mode === 'off') return report()
  let snapshot: TaskSnapshot
  try {
    snapshot = await ctx.task.snapshotIn(storeId)
  } catch (error) {
    log?.(`review agent: store ${storeId} could not be read (${error instanceof Error ? error.message : String(error)}); nothing was scanned`)
    return report()
  }
  const accepted = acceptedSourcesOf(snapshot, mode)
  const targets = options.source === undefined ? accepted : accepted.filter(source => sameSource(source, options.source!))
  if (targets.length === 0) return report()

  const root = liveRootAgentOf(ctx, storeId)
  const attempts = await readReviewAgentAttempts(storeId)
  for (const source of targets) {
    const mine = attempts.filter(attempt => sameSource(attempt.source, source))
    // The attempt this scan answers with: the source's newest one still open,
    // else its newest at all. An older settled attempt never hides a later open
    const open = mine.filter(attempt => attempt.settlement === undefined).at(-1)
    const existing = open ?? mine.at(-1)
    // Every attempt of this source is settled: read the newest one and review
    // nothing. An *open* attempt is not skipped here — whether it is dead (its
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
function refusalReason(code: ReviewAgentRefusalCode, budget: { used: number; max: number }): string {
  if (code === 'budget-exhausted') return `budget exhausted: the store's review allowance is spent (${budget.used}/${budget.max})`
  if (code === 'request-key-required') return 'the source was already reviewed and this scan names no key'
  if (code === 'iteration-cap') return "the source's rounds are spent; the cap ends the iteration"
  return 'the source already has an attempt with a different focus'
}

/** How the recovery one decision performed reads in the scan's own words — the dead attempt the ledger settled on this call — or nothing when this decision recovered none. */
function recoveryReason(recovered: readonly ReviewAgentAttempt[]): string | undefined {
  const attempt = recovered[0]
  if (attempt === undefined) return undefined
  const status = attempt.settlement?.status ?? 'interrupted'
  const note = attempt.settlement?.note === undefined ? '' : `: ${attempt.settlement.note}`
  return `the attempt found open with no process running it (session ${attempt.sessionId}) was recorded ${status}${note}`
}

/** Install the two triggers of the automatic scan on this deployment's context: one terminal review at a time, and one whole graph activation — each honouring the deployment's `supervision.autoReview`. */
export function installReviewAgentAutoTrigger(ctx: Context, options: { log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? warnLine(ctx)
  const disposers: (() => void)[] = [
    ctx.taskRuntime.registerTerminalReviewListener((fact: TerminalReviewFact) => {
      const mode = supervisionSettings().autoReview
      const accepted = mode !== 'off' && (fact.outcome === 'failed' || (mode === 'all' && fact.outcome === 'verified'))
      if (!accepted) return
      backgroundScan(log, 'review agent', () => scanFailedReviewSources(ctx, fact.storeId, {
        source: { taskId: fact.taskId, runId: fact.runId },
        log,
      }))
    }),
    installGraphSelectedScan(ctx, { log, label: 'review agent' }, graph =>
      scanFailedReviewSources(ctx, rootTaskStoreId(graph.rootSessionId), { log })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
