/**
 * The A6 hand-off consumption, as an act: start the **supervisor** a pending
 * Diagnosis is delegated to (plan §F.4).
 *
 * What a hand-off is, and what it is not. The Diagnosis is the fact: it is
 * persisted by whoever wrote it (the reviewer, `task_diagnose`) and it is
 * immutable. Consuming it means exactly one thing — starting the coordinator that
 * takes it up — and that act is idempotent per **diagnosis**: a repeat, a restart
 * and the activation scan all answer with the supervisor the diagnosis already
 * has, and a diagnosis that was never started stays readable as the pending
 * hand-off it is. Nothing here opens a candidate, evaluates one or writes
 * production: the coordinator does that through the evolution tools, and a person
 * still decides the promotion. The rules this entry acts on — which suggestions
 * this build can execute, what the hand-off's identity is, which named stop keeps
 * it pending — live in `handoff-rules.ts`, and the review pack reads its answer
 * there too, so the state a reader sees is the answer this entry would act on.
 *
 * The delegation is A5's: the same ledger (`review-agent-ledger.ts`), the same
 * admission region, the same per-store allowance, and a `started` row naming the
 * session — the row the context plane reads a read domain from, so the supervisor
 * may `context_read` the graph it was delegated into and nothing else. What
 * differs by role: the hand-off is deduped by its diagnosis rather than by a
 * review source, and a started supervisor row is the hand-off's *terminal* fact
 * (the coordinator owns it from there), so a later process must not "recover" it
 * as a dead attempt. A claim that never reached model input is not an identity:
 * the region settles it `interrupted`, and the hand-off is free for a fresh
 * consumption — a spawn that failed spent nothing.
 *
 * The coordinator has no TaskRun of its own and does not impersonate the root
 * (plan §F.4: 无业务 Run、不冒充 root): its session is a published member of the
 * graph, spawned from the root session exactly as a reviewer is, and its whole
 * surface is {@link SUPERVISOR_BASELINE}.
 * @module @dangosys/dsh-singularity-agent/evolution-handoff
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { Diagnosis } from '@dangosys/dsh-singularity-task'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import {
  admitReviewAgent,
  readReviewerDelegation,
  settleReviewAgentAttempt,
  type ReviewAgentAttemptRequest,
} from './review-agent-ledger.ts'
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

/**
 * The live agent a coordinator spawns from — the shape `ToolRunContext.agent` and
 * the agent registry both answer with. Declared structurally here so this module
 * depends on the agent plane through a tool call's context (or the registry) and
 * never through an import of the module that mints reviewers.
 */
export type ReviewParentAgent = NonNullable<ToolRunContext['agent']>

/** The delegator a hand-off is started from, resolved the way the A5 scan resolves a reviewer's parent. */
export interface HandoffDelegator {
  readonly sessionId: string
  readonly agent: ReviewParentAgent
}

/**
 * The graph's root session and its live agent for one root store, or `undefined`
 * when this process does not hold the root live. The store is **placed** through
 * the registry (`graphs.list()` and each graph's own root session), never derived
 * from the id's text: a store no graph owns is one this deployment must not spawn
 * a coordinator for.
 */
export async function handoffDelegatorOf(ctx: Context, storeId: string): Promise<HandoffDelegator | undefined> {
  const graphs = optionalService<{ list(): Promise<readonly { rootSessionId: unknown }[]> }>(ctx, 'graphs')
  const registry = optionalService<{ get(id: string): ReviewParentAgent | undefined }>(ctx, 'agents')
  let rootSessionId: string | undefined
  try {
    for (const graph of await graphs?.list() ?? []) {
      const candidate = String(graph.rootSessionId)
      if (rootTaskStoreId(candidate) === storeId) {
        rootSessionId = candidate
        break
      }
    }
  } catch {
    return undefined
  }
  if (rootSessionId === undefined) return undefined
  const agent = registry?.get(rootSessionId)
  return agent === undefined ? undefined : { sessionId: rootSessionId, agent }
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

/**
 * Consume one hand-off: decide (switch, suggestions, allowance), and — when
 * nothing stands in the way — spawn its supervisor, under the same admission
 * region and the same ledger a review attempt uses.
 *
 * The order inside the region is A5's own: decide, claim (durable before any
 * handle exists), spawn with the started row written by `beforePrompt` — so the
 * delegation is durable *and read back* before the coordinator's first model
 * input, and a store's second consumption cannot slip a claim in between the read
 * and the write. Nothing here waits for the coordinator: its started row is the
 * hand-off's terminal fact, so the call answers as soon as the session exists.
 */
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
    await admission.claim(request)
    const prompt = supervisorPrompt({ diagnosis, sourceOutcome: input.sourceOutcome, sourceRef: input.sourceRef })
    let spawnFailure: string | undefined
    const handle = await ctx.agentRuntime.spawn(delegator.agent, {
      sessionId: supervisorSessionId,
      name: `supervisor for ${diagnosis.diagnosisId}`,
      prompt: [{ type: 'text', text: prompt }],
      agentPreset: input.agentPreset ?? COORDINATION_PRESET,
      grant: supervisorGrant(),
      beforePrompt: async () => {
        await admission.start({ taskId: source.taskId, sessionId: supervisorSessionId, actor: delegator.sessionId })
        // The row is durable, so the run is spent whether or not the spawn
        // survives the read-back below — and whether or not the coordinator ever
        // does anything with the hand-off.
        const back = await readReviewerDelegation(supervisorSessionId)
        if (back === undefined || back.rootStoreId !== storeId || back.taskId !== source.taskId) {
          throw new Error(
            `evolution hand-off: the delegation of supervisor session "${supervisorSessionId}" could not be read back from the ledger ` +
            `(expected task ${source.taskId} in ${storeId}); no model input was sent`,
          )
        }
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }).catch((error: unknown) => {
      spawnFailure = error instanceof Error ? error.message : String(error)
      return undefined
    })
    if (handle === undefined) {
      // A spawn that failed before its started row spent nothing, but its claim
      // stands: recording the terminal fact is what lets the hand-off be taken up
      // by a later consumption instead of looking in flight forever.
      await settleReviewAgentAttempt({
        rootStoreId: storeId,
        taskId: source.taskId,
        sessionId: supervisorSessionId,
        status: 'interrupted',
        note: `the supervisor could not be spawned: ${spawnFailure ?? 'unknown error'}`,
      }).catch(() => undefined)
      return { diagnosisId: diagnosis.diagnosisId, result: 'failed', reason: spawnFailure ?? 'unknown error' }
    }
    return { diagnosisId: diagnosis.diagnosisId, result: 'started', sessionId: supervisorSessionId }
  })
}

/** What one store's scan consumed, and what it left alone. */
export interface HandoffScanReport {
  readonly storeId: string
  readonly consumptions: readonly HandoffConsumption[]
  /** The named reason no consumption happened at all, when the store could not be scanned. */
  readonly skipped?: string
}

/**
 * Every pending hand-off of one store, consumed in the order the diagnoses were
 * written. A diagnosis that carries suggestions is a hand-off; a conclusion
 * without suggestions is not touched.
 *
 * Never throws for the work it does: a store it cannot read, a hand-off it cannot
 * start and a spawn that failed all come back as entries (and as log lines when a
 * `log` is given), because every caller of this scan is a trigger — a recorded
 * diagnosis, an activation — that must not take a store down with a coordinator.
 */
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

/**
 * Consume one store's hand-off for one diagnosis, if it is pending — the moment
 * the reviewer that recorded it is the caller (the record just became durable,
 * and no event exists for a store's diagnosis). The store is read here rather
 * than trusted from the caller: a diagnosis the store does not hold is reported
 * by name and nothing is started.
 */
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

/** The warning channel the plugin has, when the deployment mounted a logger. */
function softWarn(ctx: Context): (line: string) => void {
  const logger = (ctx as { logger?: (name: string) => { warn(format: string): void } }).logger
  return line => logger?.('singularity-agent').warn(line)
}

/**
 * Install the hand-off trigger of this deployment: a graph that is explicitly
 * activated scans its store for pending hand-offs — what a process that booted
 * over a store with a pending hand-off does, and what a repeat consumption after
 * a restart answers from the ledger. The other moment — a diagnosis with
 * suggestions becoming durable — is reported by the attempt that recorded it
 * (`review-agent-run.ts`): no event exists for a store's diagnosis record, and the
 * run that wrote it is the only place that knows.
 *
 * The listener does its work off the caller's path: it starts the scan and
 * returns immediately, and a scan that fails is reported on the log rather than
 * thrown into the activation that woke it.
 * @returns a disposer that removes the listener.
 */
export function installSupervisorHandoffTrigger(ctx: Context, options: { readonly log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? softWarn(ctx)
  const background = (work: () => Promise<unknown>): void => {
    void work().catch(error => {
      log(`evolution hand-off: the scan could not run (${error instanceof Error ? error.message : String(error)})`)
    })
  }
  const dispose = ctx.on('graphs/selected', graph => {
    background(async () => await consumePendingHandoffs(ctx, rootTaskStoreId(graph.rootSessionId), { log }))
  })
  return () => dispose()
}
