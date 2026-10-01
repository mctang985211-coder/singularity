/**
 * Settlement: terminal review records, enrichment, breach reporting and the runtime fallback.
 */

import type {
  ReviewBlocker,
  ReviewCriterion,
  ReviewDimensions,
  ReviewMetrics,
  ReviewOutcome,
  RunId,
  TaskId,
  TaskRun,
} from '@dangosys/dsh-singularity-task'
import { capabilitySnapshot, workerBaseline } from '../capability.ts'
import { releaseAskingSessions } from '../question.ts'
import { message } from '../helpers.ts'
import type { OrchestrateEnv, ReviewEnrichment, RuntimeSettlementEnv } from './types.ts'
import { escalationHint } from './verify.ts'
import { describeOwner, releaseLayer } from '../workspace.ts'
import type { WorkspaceOwner, WorkspaceRegistry } from '../workspace.ts'

/**
 * The review dimensions and the effort counters for one terminal record,
 * assembled from what the store already holds plus one optional session read.
 */
async function reviewEnrichment(
  env: RuntimeSettlementEnv,
  storeId: string,
  taskId: TaskId,
  outcome: ReviewOutcome,
  run: TaskRun | undefined,
  criteria: readonly ReviewCriterion[] | undefined,
): Promise<ReviewEnrichment> {
  try {
    const task = await env.task.taskIn(storeId, taskId)
    const snapshot = await env.task.snapshotIn(storeId)
    const manifest = snapshot.capabilities[taskId]
    const observation =
      run === undefined || env.observeSession === undefined
        ? undefined
        : await env.observeSession(run.sessionId).catch(() => undefined)

    const grantedSkills =
      manifest === undefined
        ? undefined
        : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.skills))].sort()
    const grantedTools =
      manifest === undefined
        ? undefined
        : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.tools))].sort()
    /** Granted MCP servers' tool prefix (`mcp__<server>__`): their calls ride the spawn-mounted plane, outside the label/baseline vocabulary. */
    const mcpPrefixes =
      manifest === undefined
        ? []
        : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.mcpServers ?? []))].map(
            name => `mcp__${name}__`,
          )
    const baseline = workerBaseline()
    const recorded = criteria ?? []
    /** Loaded skill names, deduplicated, and the ones no granted capability covers. */
    const loadedSkills = observation?.skillCalls === undefined ? undefined : [...new Set(observation.skillCalls)].sort()
    const contextEfficiency =
      observation === undefined || (observation.tokens === undefined && observation.compactions === undefined)
        ? undefined
        : {
            ...(observation.tokens === undefined ? {} : { tokens: { ...observation.tokens } }),
            ...(observation.compactions === undefined ? {} : { compactions: observation.compactions }),
          }

    const dimensions: ReviewDimensions = {
      outcomeCorrectness: {
        outcome,
        criteriaCount: recorded.length,
        unmetCriterionIds: recorded.filter(item => item.verdict !== 'pass').map(item => item.criterionId),
      },
      taskSpecification: {
        objectivePresent: task.objective.trim().length > 0,
        criteriaCount: task.acceptanceCriteria.length,
        criteriaWithCommand: task.acceptanceCriteria.filter(item => item.command !== undefined).length,
      },
      acceptance: {
        criteria: task.acceptanceCriteria.map(item => ({
          criterionId: item.criterionId,
          mode: item.verificationMode,
          hasCommand: item.command !== undefined,
          mandatory: item.mandatory,
        })),
      },
      decomposition: {
        depth: task.depth,
        decompositionStatus: task.decompositionStatus,
        childCount: task.childTaskIds.length,
        incomingEdges: snapshot.edges.filter(edge => edge.to === taskId).length,
        outgoingEdges: snapshot.edges.filter(edge => edge.from === taskId).length,
      },
      ...(manifest === undefined
        ? {}
        : {
            capabilityCoverage: {
              closure: manifest.closure,
              granted: capabilitySnapshot(manifest),
              missing: [...manifest.missing],
            },
          }),
      ...(grantedSkills === undefined
        ? {}
        : {
            skillFit: {
              granted: grantedSkills,
              ...(loadedSkills === undefined
                ? {}
                : {
                    loaded: loadedSkills,
                    loadedOutsideGrant: loadedSkills.filter(name => !grantedSkills.includes(name)),
                  }),
            },
          }),
      ...(grantedTools === undefined
        ? {}
        : {
            toolFit: {
              granted: grantedTools,
              ...(observation?.tools === undefined
                ? {}
                : {
                    called: observation.tools.calls.map(call => ({ ...call })),
                    calledOutsideGrant: observation.tools.calls
                      .map(call => call.name)
                      .filter(
                        name =>
                          !grantedTools.includes(name) &&
                          !baseline.includes(name) &&
                          !mcpPrefixes.some(prefix => name.startsWith(prefix)),
                      )
                      .sort(),
                  }),
            },
          }),
      ...(contextEfficiency === undefined ? {} : { contextEfficiency }),
    }

    const calls =
      observation?.tools === undefined ? undefined : observation.tools.calls.reduce((sum, call) => sum + call.count, 0)
    const metrics: ReviewMetrics = {
      ...(observation?.tokens === undefined ? {} : { tokens: { ...observation.tokens } }),
      ...(calls === undefined || observation?.tools === undefined
        ? {}
        : { toolCalls: { calls, failures: observation.tools.failures } }),
      ...(observation?.humanInterventions === undefined ? {} : { humanInterventions: observation.humanInterventions }),
      ...(run === undefined || task.runIds.length === 0 ? {} : { retries: task.runIds.length - 1 }),
      ...(criteria === undefined ? {} : { evidenceLogs: criteria.filter(item => item.logRef !== undefined).length }),
    }

    return {
      dimensions,
      ...(Object.keys(metrics).length === 0 ? {} : { metrics }),
    }
  } catch {
    return {}
  }
}

/**
 * The post-hoc half of the budget (see {@link BudgetConfig}): the members the
 * orchestrator cannot observe in flight are checked once, at terminal time,
 */
async function budgetBreaches(env: RuntimeSettlementEnv, run: TaskRun): Promise<string[]> {
  const budget = env.budget
  if (budget === undefined || env.observeSession === undefined) return []
  if (budget.maxToolCalls === undefined && budget.tokens === undefined) return []
  const observation = await env.observeSession(run.sessionId).catch(() => undefined)
  if (observation === undefined) return []
  const breaches: string[] = []
  if (budget.maxToolCalls !== undefined && observation.tools !== undefined) {
    const calls = observation.tools.calls.reduce((sum, call) => sum + call.count, 0)
    if (calls > budget.maxToolCalls) {
      breaches.push(
        `budget exceeded: maxToolCalls (observed ${calls} tool calls over the limit ${budget.maxToolCalls}; post-hoc check at terminal time — the run was not stopped in flight) — ${escalationHint(
          'the run already spent more tool calls than its budget allows',
          'the run finished before the breach was observable',
          'raise the budget, split the task, or accept the overspend',
        )}`,
      )
    }
  }
  if (budget.tokens !== undefined && observation.tokens !== undefined) {
    const tokens = observation.tokens
    const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
    if (total > budget.tokens) {
      breaches.push(
        `budget exceeded: tokens (observed ${total} whole-session tokens over the limit ${budget.tokens}; post-hoc check at terminal time, session-scoped cumulative — the run was not stopped in flight) — ${escalationHint(
          'the run already spent more tokens than its budget allows',
          'the run finished before the breach was observable',
          'raise the budget, split the task, or accept the overspend',
        )}`,
      )
    }
  }
  return breaches
}

async function evidenceRefsFor(env: RuntimeSettlementEnv, storeId: string, runId: RunId): Promise<string[]> {
  return (await env.task.snapshotIn(storeId)).evidence
    .filter(item => item.taskRunId === runId)
    .map(item => item.evidenceId)
}

/** Run start → terminal transition in ms; the terminal mark just landed, so finishedAt is in the store. */
export async function runDurationMs(env: RuntimeSettlementEnv, storeId: string, run: TaskRun): Promise<number> {
  const finishedAt = (await env.task.runIn(storeId, run.runId)).finishedAt
  const end = finishedAt === undefined ? Date.now() : Date.parse(finishedAt)
  return Math.max(0, end - Date.parse(run.startedAt))
}

/** Options for {@link recordTerminalReview}; a runless (blocked) record omits `run`. */
interface TerminalReviewOptions {
  run?: TaskRun
  localizedCause?: string
  anomalies?: readonly string[]
  relatedTaskIds?: readonly TaskId[]
  criteria?: readonly ReviewCriterion[]
  logTail?: string
  blockedBy?: readonly ReviewBlocker[]
}

/**
 * Every run walked to a terminal state gets exactly one review record, written
 * in the same moment right after the terminal status event — the discipline
 */
export async function recordTerminalReview(
  env: RuntimeSettlementEnv,
  storeId: string,
  taskId: TaskId,
  outcome: ReviewOutcome,
  options: TerminalReviewOptions = {},
): Promise<void> {
  const enrichment = await reviewEnrichment(env, storeId, taskId, outcome, options.run, options.criteria)
  const breaches = options.run === undefined ? [] : await budgetBreaches(env, options.run)
  await env.task.recordReviewIn(
    storeId,
    {
      taskId,
      ...(options.run === undefined ? {} : { runId: options.run.runId, sessionId: options.run.sessionId }),
      outcome,
      evidenceRefs: options.run === undefined ? [] : await evidenceRefsFor(env, storeId, options.run.runId),
      anomalies: [...(options.anomalies ?? []), ...breaches],
      ...(options.localizedCause === undefined ? {} : { localizedCause: options.localizedCause }),
      ...(options.relatedTaskIds === undefined || options.relatedTaskIds.length === 0
        ? {}
        : { relatedTaskIds: [...options.relatedTaskIds] }),
      ...(options.run === undefined ? {} : { durationMs: await runDurationMs(env, storeId, options.run) }),
      ...(options.criteria === undefined ? {} : { criteria: options.criteria.map(item => ({ ...item })) }),
      ...(options.logTail === undefined ? {} : { logTail: options.logTail }),
      ...(options.blockedBy === undefined ? {} : { blockedBy: options.blockedBy.map(item => ({ ...item })) }),
      ...(enrichment.dimensions === undefined ? {} : { dimensions: enrichment.dimensions }),
      ...(enrichment.metrics === undefined ? {} : { metrics: enrichment.metrics }),
    },
    env.actor,
  )
  /**
   * The record is durable: the deployment may now be told about it. Handing the
   * fact over is not waiting for what it does with it (A5) — a listener runs the
   */
  env.onTerminalReview?.({
    storeId,
    taskId,
    runId: options.run?.runId ?? null,
    outcome,
  })
}

/** Best-effort owner notification; a deployment without the seam, or a throwing one, changes nothing. */
export function notifyOwner(env: RuntimeSettlementEnv, sessionId: string | undefined, text: string): void {
  if (sessionId === undefined || env.notify === undefined) return
  try {
    env.notify(sessionId, text)
  } catch {
    // A notification is a report, not a step: a deployment whose followup path
    // is broken must not turn that into a failed settlement.
  }
}

/**
 * ------------------------------------------------------------------------- *
 * Settlements the runtime drives from the outside (§3.6)
 */

/**
 * Settle one run terminal from outside the orchestration — a graph removal, or
 * a recovery pass that refuses to continue a run — with the same terminal-record
 */
export async function settleRunFromRuntime(
  env: RuntimeSettlementEnv,
  storeId: string,
  run: TaskRun,
  status: 'cancelled' | 'failed',
  reason: string,
): Promise<void> {
  const current = await env.task.runIn(storeId, run.runId)
  if (current.status !== 'running') return
  const snapshot = await env.task.snapshotIn(storeId)
  const task = snapshot.tasks.find(candidate => candidate.taskId === current.taskId)
  const relatedTaskIds = task?.childTaskIds ?? []
  try {
    await env.task.markRunStatusIn(storeId, current.taskId, current.runId, status, env.actor, { reason })
  } catch (error) {
    /**
     * Another settlement path can win this race: a driver's own abort branch, or
     * this same cancellation arriving through the batch. The store is the arbiter
     */
    const settled = await env.task.runIn(storeId, current.runId).catch(() => undefined)
    if (settled === undefined || settled.status === 'running') throw error
    return
  }
  if (!snapshot.reviews.some(review => review.runId === current.runId)) {
    await recordTerminalReview(env, storeId, current.taskId, status, {
      run: current,
      // Only a failed record carries a localized cause; a cancellation's reason
      // is the status event's and the record's anomalies.
      ...(status === 'failed' ? { localizedCause: reason } : {}),
      anomalies: [reason],
      relatedTaskIds,
    })
  }
  env.onRunSettled?.(storeId, current.taskId, current.runId, status)
  /**
   * The questions addressed to this run stop being open the moment it settles
   * (A4 §F.1: an open question needs *both* runs running), so the runs that asked
   */
  if (env.gate !== undefined) {
    try {
      releaseAskingSessions(env.gate, await env.task.snapshotIn(storeId), current.runId)
    } catch (error) {
      notifyOwner(
        env,
        current.sessionId,
        `task-runtime: the question blocks of the runs that asked run "${current.runId}" could not be recomputed after it settled ` +
          `(${message(error)}); the store's own derivation is unchanged and the next recovery recomputes them`,
      )
    }
  }
  await releaseWorkspaceLayer(env, runOwner(storeId, current.taskId, current.runId), current.sessionId)
  notifyOwner(env, current.sessionId, `task-runtime: run "${current.runId}" was settled ${status}: ${reason}`)
}

/* --- workspace handovers (A3 §3.4) --------------------------------------- */

/** The workspace this orchestration may own, when the deployment names one. */
function workspaceOf(env: RuntimeSettlementEnv): { registry: WorkspaceRegistry; workspace: string } | undefined {
  if (env.workspaces === undefined || env.workspacePath === undefined) return undefined
  return { registry: env.workspaces, workspace: env.workspacePath }
}

export function runOwner(storeId: string, taskId: TaskId, runId: RunId): WorkspaceOwner {
  return { kind: 'run', storeId, taskId, runId, since: new Date().toISOString() }
}

export function batchOwner(storeId: string, taskId: TaskId, batchId: string): WorkspaceOwner {
  return { kind: 'batch', storeId, taskId, batchId, since: new Date().toISOString() }
}

/**
 * Hand the workspace from the holder that has it to `next`, checking that the
 * holder is the one the caller believes it is.
 */
export async function handOverWorkspace(
  env: OrchestrateEnv,
  next: WorkspaceOwner,
  expected: (owner: WorkspaceOwner | undefined) => boolean,
  sessionId: string | undefined,
  what: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const held = workspaceOf(env)
  if (held === undefined) return { ok: true }
  const top = held.registry.ownerOf(held.workspace)
  if (!expected(top)) {
    const reason =
      `workspace ${held.workspace} is not held by the writer ${what} expected: ` +
      `${top === undefined ? 'this process holds no claim on it' : `its holder is ${describeOwner(top)}`}`
    notifyOwner(env, sessionId, `task-runtime: ${reason}`)
    return { ok: false, reason }
  }
  await held.registry.push(held.workspace, top as WorkspaceOwner, next)
  return { ok: true }
}

/** Release one layer the caller knows is on top, reporting — never hiding — a mismatch. */
export async function releaseWorkspaceLayer(
  env: RuntimeSettlementEnv,
  owner: WorkspaceOwner,
  sessionId: string | undefined,
): Promise<void> {
  const held = workspaceOf(env)
  if (held === undefined) return
  const { conflict } = await releaseLayer(
    held.registry,
    held.workspace,
    top =>
      top.kind === owner.kind &&
      top.storeId === owner.storeId &&
      top.taskId === owner.taskId &&
      top.runId === owner.runId &&
      top.batchId === owner.batchId,
  )
  if (conflict === undefined) return
  /**
   * A layer that is no longer on top because this store's ownership moved on is
   * not a disagreement: the settlement and the batch driver can both release the
   */
  if (conflict.storeId === owner.storeId) return
  notifyOwner(
    env,
    sessionId,
    `task-runtime: workspace ${held.workspace} was expected to be released by ${describeOwner(owner)}, but its holder is ${describeOwner(conflict)}; the layer is left in place`,
  )
}

/**
 * Hold the workspace for one verifier call: the verification reads the result
 * exclusively, so the run's own hold is handed to a `verifier` layer and
 */
export async function withVerifierWorkspace<T>(
  env: OrchestrateEnv,
  storeId: string,
  taskId: TaskId,
  runId: RunId,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  const held = workspaceOf(env)
  if (held === undefined || env.workspaces === undefined) return await work()
  const top = held.registry.ownerOf(held.workspace)
  if (top === undefined || top.storeId !== storeId) {
    throw new Error(
      `task-runtime: run "${runId}" cannot be verified: its workspace ${held.workspace} is ` +
        `${top === undefined ? 'held by nobody in this process' : `held by ${describeOwner(top)}`}, not by store ${storeId}; ` +
        "a verifier runs only while the run's own store holds the workspace it judges",
    )
  }
  const verifier: WorkspaceOwner = { kind: 'verifier', storeId, taskId, runId, since: new Date().toISOString() }
  await held.registry.push(held.workspace, top, verifier)
  try {
    return await work()
  } finally {
    await releaseWorkspaceLayer(env, verifier, sessionId)
  }
}
