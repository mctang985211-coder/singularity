/** The A6 hand-off consumption, as an act: start the **supervisor** a pending Diagnosis is delegated to (plan §F.4). @module @dangosys/dsh-singularity-agent/evolution-handoff */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { Diagnosis } from '@dangosys/dsh-singularity-task'
import { warnLine } from '../log.ts'
import { admitReviewAgent, type ReviewAgentAttemptRequest } from './ledger.ts'
import { liveRootAgentOf, type ReviewParentAgent } from './identity.ts'
import { spawnUnderClaim } from './spawn-under-claim.ts'
import { installGraphSelectedScan } from './trigger.ts'
import {
  COORDINATION_PRESET,
  evolutionEnabled,
  handoffPreflight,
  handoffSourceOf,
  handoffSourceRef,
  supervisorGrant,
  supervisorHandoffDigest,
  supervisorPrompt,
  type HandoffStopCode,
} from './handoff-rules.ts'

/** The delegator a hand-off is started from, resolved the way the A5 scan resolves a reviewer's parent. */
export interface HandoffDelegator {
  readonly sessionId: string
  readonly agent: ReviewParentAgent
}

/** The graph's root session and its live agent for one root store, or `undefined` when this process does not hold the root live. */
export async function handoffDelegatorOf(ctx: Context, storeId: string): Promise<HandoffDelegator | undefined> {
  return liveRootAgentOf(ctx, storeId)
}

/** One hand-off consumption, as its caller may render it. */
export type HandoffConsumption =
  | { readonly diagnosisId: string; readonly result: 'started'; readonly sessionId: string }
  | { readonly diagnosisId: string; readonly result: 'existing'; readonly sessionId: string }
  | { readonly diagnosisId: string; readonly result: 'in-flight'; readonly sessionId: string }
  | { readonly diagnosisId: string; readonly result: 'stopped'; readonly code: HandoffStopCode; readonly reason: string }
  | { readonly diagnosisId: string; readonly result: 'failed'; readonly reason: string }

/** What one consumption was asked for. */
export interface SupervisorHandoffRequest {
  /** The root task store whose diagnosis this is — the caller derived it from its own graph, never from a model argument. */
  readonly storeId: string
  readonly diagnosis: Diagnosis
  /** The graph root session and its live agent the coordinator is spawned from. */
  readonly delegator: HandoffDelegator
  /** The hand-off's source as the store holds it: its ref and the outcome its review settled. */
  readonly sourceRef: string
  readonly sourceOutcome: string
  readonly signal?: AbortSignal
  /** The preset to mount; {@link COORDINATION_PRESET} by default. */
  readonly agentPreset?: string
}

/** Consume one hand-off: decide (switch, suggestions, allowance), and — when nothing stands in the way — spawn its supervisor, under the same admission region and the same ledger a review attempt uses. */
export async function startSupervisorHandoff(
  ctx: Context,
  input: SupervisorHandoffRequest,
): Promise<HandoffConsumption> {
  const { storeId, diagnosis, delegator } = input
  const preflight = handoffPreflight({ enabled: evolutionEnabled(ctx), diagnosis })
  if (preflight !== undefined) {
    return { diagnosisId: diagnosis.diagnosisId, result: 'stopped', code: preflight.code, reason: preflight.reason }
  }
  const source = handoffSourceOf(diagnosis)
  const supervisorSessionId = SessionId(randomUUID())
  const request: ReviewAgentAttemptRequest = {
    role: 'supervisor',
    source,
    requestKey: null,
    reason: null,
    diagnosisId: diagnosis.diagnosisId,
    handoffDigest: supervisorHandoffDigest(storeId, diagnosis),
    actor: delegator.sessionId,
    sessionId: supervisorSessionId,
  }
  return await admitReviewAgent(storeId, async admission => {
    const { plan } = await admission.plan(request)
    if (plan.kind === 'refused') {
      const reason = plan.code === 'budget-exhausted'
        ? `the store's coordination allowance is spent (${plan.budget.used}/${plan.budget.max}) — nothing was started and the hand-off stays pending`
        : `diagnosis ${diagnosis.diagnosisId} already has a supervisor claim with another hand-off content ` +
          `(session ${plan.attempt?.sessionId ?? 'unknown'}); one diagnosis is not two hand-offs, so nothing was started`
      const code: HandoffStopCode = plan.code === 'budget-exhausted' ? 'budget-exhausted' : 'handoff-conflict'
      return { diagnosisId: diagnosis.diagnosisId, result: 'stopped', code, reason }
    }
    if (plan.kind === 'reuse') {
      return { diagnosisId: diagnosis.diagnosisId, result: 'existing', sessionId: plan.attempt.sessionId }
    }
    if (plan.kind === 'in-flight') {
      return { diagnosisId: diagnosis.diagnosisId, result: 'in-flight', sessionId: plan.attempt.sessionId }
    }
    const spawned = await spawnUnderClaim({
      ctx,
      admission,
      storeId,
      request,
      sessionId: supervisorSessionId,
      taskId: source.taskId,
      actor: delegator.sessionId,
      parent: delegator.agent,
      name: `supervisor for ${diagnosis.diagnosisId}`,
      preset: input.agentPreset ?? COORDINATION_PRESET,
      grant: supervisorGrant(),
      signal: input.signal,
      errorLabel: 'evolution hand-off: the delegation of supervisor session',
      failureLabel: 'the supervisor could not be spawned',
      prompt: () => supervisorPrompt({ diagnosis, sourceOutcome: input.sourceOutcome, sourceRef: input.sourceRef }),
    })
    return spawned.kind === 'spawn-failed'
      ? { diagnosisId: diagnosis.diagnosisId, result: 'failed', reason: spawned.failure }
      : { diagnosisId: diagnosis.diagnosisId, result: 'started', sessionId: supervisorSessionId }
  })
}

/** What one store's scan consumed, and what it left alone. */
export interface HandoffScanReport {
  readonly storeId: string
  readonly consumptions: readonly HandoffConsumption[]
  /** The named reason no consumption happened at all, when the store could not be scanned. */
  readonly skipped?: string
}

/** Every pending hand-off of one store, consumed in the order the diagnoses were written. A diagnosis that carries suggestions is a hand-off; a conclusion without suggestions is not touched. */
export async function consumePendingHandoffs(
  ctx: Context,
  storeId: string,
  options: { readonly log?: (line: string) => void } = {},
): Promise<HandoffScanReport> {
  const { log } = options
  let snapshot
  try {
    snapshot = await ctx.task.snapshotIn(storeId)
  } catch (error) {
    const skipped = `the store could not be read (${error instanceof Error ? error.message : String(error)}); no hand-off was consumed`
    log?.(`evolution hand-off: store ${storeId} — ${skipped}`)
    return { storeId, consumptions: [], skipped }
  }
  const pending = snapshot.diagnoses.filter(diagnosis => diagnosis.proposals.length > 0)
  if (pending.length === 0) return { storeId, consumptions: [] }
  const delegator = await handoffDelegatorOf(ctx, storeId)
  if (delegator === undefined) {
    const skipped = 'the graph\'s root session for this store is not live, so no supervisor could be started'
    for (const diagnosis of pending) log?.(`evolution hand-off: ${diagnosis.diagnosisId} pending — ${skipped}`)
    return {
      storeId,
      skipped,
      consumptions: pending.map(diagnosis => ({
        diagnosisId: diagnosis.diagnosisId,
        result: 'stopped' as const,
        code: 'evolution-off' as const,
        reason: skipped,
      })),
    }
  }
  const consumptions: HandoffConsumption[] = []
  for (const diagnosis of pending) {
    const source = handoffSourceOf(diagnosis)
    const review = snapshot.reviews.find(item => item.taskId === source.taskId && (item.runId ?? null) === source.runId)
    let consumption: HandoffConsumption
    try {
      consumption = await startSupervisorHandoff(ctx, {
        storeId,
        diagnosis,
        delegator,
        sourceRef: handoffSourceRef(source),
        sourceOutcome: review?.outcome ?? 'no review record',
      })
    } catch (error) {
      consumption = {
        diagnosisId: diagnosis.diagnosisId,
        result: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    consumptions.push(consumption)
    log?.(`evolution hand-off: ${renderConsumption(consumption)}`)
  }
  return { storeId, consumptions }
}

/** Consume one store's hand-off for one diagnosis, if it is pending — the moment the reviewer that recorded it is the caller (the record just became durable, and no event exists for a store's diagnosis). */
export async function consumeHandoffDiagnosis(
  ctx: Context,
  storeId: string,
  diagnosisId: string,
  options: { readonly log?: (line: string) => void } = {},
): Promise<HandoffConsumption | undefined> {
  let snapshot
  try {
    snapshot = await ctx.task.snapshotIn(storeId)
  } catch (error) {
    options.log?.(`evolution hand-off: store ${storeId} could not be read (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
  const diagnosis = snapshot.diagnoses.find(item => item.diagnosisId === diagnosisId)
  if (diagnosis === undefined) {
    options.log?.(`evolution hand-off: store ${storeId} holds no diagnosis "${diagnosisId}"; nothing was started`)
    return undefined
  }
  const delegator = await handoffDelegatorOf(ctx, storeId)
  if (delegator === undefined) {
    options.log?.(`evolution hand-off: ${diagnosisId} pending — the graph's root session is not live, so no supervisor was started`)
    return undefined
  }
  const source = handoffSourceOf(diagnosis)
  const review = snapshot.reviews.find(item => item.taskId === source.taskId && (item.runId ?? null) === source.runId)
  const consumption = await startSupervisorHandoff(ctx, {
    storeId,
    diagnosis,
    delegator,
    sourceRef: handoffSourceRef(source),
    sourceOutcome: review?.outcome ?? 'no review record',
  })
  options.log?.(`evolution hand-off: ${renderConsumption(consumption)}`)
  return consumption
}

/** One consumption as a scan line, naming the session or the reason — never a credential and never a path. */
export function renderConsumption(consumption: HandoffConsumption): string {
  switch (consumption.result) {
    case 'started':
      return `diagnosis ${consumption.diagnosisId} — supervisor session ${consumption.sessionId} started`
    case 'existing':
      return `diagnosis ${consumption.diagnosisId} — already delegated to supervisor session ${consumption.sessionId}; nothing started`
    case 'in-flight':
      return `diagnosis ${consumption.diagnosisId} — supervisor session ${consumption.sessionId} is being started right now; nothing started`
    case 'stopped':
      return `diagnosis ${consumption.diagnosisId} pending (${consumption.code}) — ${consumption.reason}`
    case 'failed':
      return `diagnosis ${consumption.diagnosisId} — the supervisor could not be started: ${consumption.reason}`
  }
}

/** Install the hand-off trigger of this deployment: a graph that is explicitly activated scans its store for pending hand-offs — what a process that booted over a store with a pending hand-off does, and. */
export function installSupervisorHandoffTrigger(ctx: Context, options: { readonly log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? warnLine(ctx)
  return installGraphSelectedScan(ctx, { log, label: 'evolution hand-off' }, async graph =>
    await consumePendingHandoffs(ctx, rootTaskStoreId(graph.rootSessionId), { log }))
}
