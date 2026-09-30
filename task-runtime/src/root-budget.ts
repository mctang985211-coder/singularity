/**
 * What the whole tree is allowed to spend (A3 §3.5): the root's deadline, the
 * number of runs it may start.
 *
 * Why the root, and why the *start* of the root: a budget that is re-read from
 * the process that happens to be running can always be reset — restart the
 * deployment, re-open the store, replay the task, and a "two hour" limit starts
 * over. So every limit here is derived from what the store already holds:
 * `maxRuns` counts the runs in the snapshot (a crash and a re-open do not delete
 * runs, so nothing is re-counted or refunded), and the deadline is the root run's
 * own persisted `startedAt` plus the configured wall time, with the same rule for
 * every run in the tree: a run's own deadline is `min(per-run wall time, what is
 * left of the root's)` measured from its own `startedAt`, never from the moment
 * it was resumed (§7.4 — restarts do not re-time).
 *
 * Two sources of a ceiling, and only two: the deployment's `rootBudget`,
 * resolved against that same root start, and the absolute values a person
 * approved (K4, `TaskSnapshot.budgetExtensions`). An approved ceiling is a fact
 * of the store like the run count is — never re-derived from "now", never reset
 * by a restart or a configuration change, superseded only by another approved
 * ceiling — and this module is the one place both are read, so every admission,
 * driver, watchdog and replay path asks here instead of deriving a bound of its
 * own. A dimension the store has no approved ceiling for keeps the deployment's
 * configured value, and a dimension neither source sets is not limited.
 *
 * Why a missing start refuses instead of being invented: an old store, or a root
 * whose run never recorded a start, has no honest instant to measure from.
 * Substituting "now" would silently grant a fresh full budget — exactly the
 * failure this module exists to prevent — so {@link resolveRootBudget} reports
 * the gap and the caller refuses to start.
 *
 * Everything here is a pure function of the snapshot and the config. The
 * configuration's *shape* is one more guard: a hard limit this deployment cannot
 * enforce is refused at load ({@link assertRootBudgetConfig}) rather than
 * accepted and quietly ignored.
 * @module @dangosys/dsh-singularity-task-runtime/root-budget
 */

import type { RunId, TaskId, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { approvedBudgetCeilings, rootTaskStoreId } from '@dangosys/dsh-singularity-task'

/**
 * The root budget as configured (`Config.rootBudget`). Every member is optional:
 * absent means the deployment sets no such limit, which is a statement about
 * what is enforced and must be read as one.
 */
export interface RootBudgetConfig {
  /** Wall-clock the whole tree may take, measured from the root run's own `startedAt`. */
  wallTimeMs?: number
  /** How many runs the tree may start, counted over the store's whole run list. */
  maxRuns?: number
  /**
   * Writes that may hold one workspace at a time. This deployment enforces
   * exactly one, so any other value is a limit it cannot honor — see
   * {@link assertRootBudgetConfig}.
   */
  maxConcurrentWrites?: number
}

/**
 * The two ceilings a root budget is measured in. Every member is optional, and
 * absent means the deployment sets no such limit — which is a statement about
 * what is enforced and has to be read as one.
 */
export interface RootBudgetCeilings {
  /** The run count the tree may reach. */
  readonly maxRuns?: number
  /** The instant the tree must stop by. */
  readonly deadlineAt?: string
}

/**
 * A resolved root budget: the tree it belongs to, the instant it started, and
 * the limits in force — with the deployment's own ceilings kept beside them.
 *
 * Two ceilings per dimension, deliberately: `configured` is what this
 * deployment's `rootBudget` resolves to against the root's start, and the
 * top-level members are what is *in force*. They differ exactly when a person
 * has raised a ceiling (K4, `TaskSnapshot.budgetExtensions`), and a reader that
 * has to show "the total the deployment set" beside "the total now approved"
 * needs both rather than one derived from the other.
 */
export interface ResolvedRootBudget {
  /** The store's root task (`parentTaskId === undefined`) — the tree the budget belongs to. */
  readonly rootTaskId: TaskId
  /** The root run's persisted start, read from the store: the instant the budget was accepted. */
  readonly acceptedAt: string
  /**
   * The deadline in force: the approved absolute deadline when the store holds
   * one, else `acceptedAt + wallTimeMs` when a wall time is configured.
   */
  readonly deadlineAt?: string
  /** The run ceiling in force: the approved absolute count when the store holds one, else the configured count. */
  readonly maxRuns?: number
  /** What the deployment itself configures, resolved against the same root start: the values before any approved raise. */
  readonly configured: RootBudgetCeilings
}

export type RootBudgetResolution =
  | ({ readonly ok: true } & ResolvedRootBudget)
  | { readonly ok: false; readonly reason: string }

/**
 * Whether a root budget enforces anything at all. The configuration's schema
 * materializes an absent `rootBudget` as an empty object, so the presence of an
 * object is not the question a refusal may ask: a budget with no member in force
 * is no budget, and an entry that refuses work over an unmeasurable tree would
 * otherwise refuse it for a limit this deployment never set. Every refusal that
 * is "a configured limit cannot be measured" asks this first.
 */
export function hasRootLimits(config: RootBudgetConfig | undefined): boolean {
  return config !== undefined
    && (config.wallTimeMs !== undefined || config.maxRuns !== undefined || config.maxConcurrentWrites !== undefined)
}

/** The verdict a start or a batch admission gets. A refusal always names the limit it hit. */
export type BudgetVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

function instant(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The root budget a snapshot is under, or the reason none can be measured.
 *
 * The owner is the store's own root: among the parentless tasks, the one whose
 * run is bound to the root session the store id derives from
 * (`rootTaskStoreId`) — the same durable rule the recovery path uses to tell a
 * store's own root run apart from a replay's. A replay's task is parentless by
 * design and carries no such binding (its session is minted for the replay), so
 * it shares the root's total instead of claiming a budget of its own (§3.5, the
 * funding-root reference); inventing one for it would hand every experiment a
 * fresh allowance. No run naming a root session of this store means no owner,
 * and the store keeps the honest recovery diagnostic rather than a guess.
 *
 * The ceilings that come back are the ones in force: per dimension, the value the
 * last approved extension left when the store holds one (K4), and the configured
 * value otherwise. An approved ceiling is *not* re-derived from the wall time the
 * deployment configures today — a person's decision is not a function of the
 * configuration file — and a deployment that stops configuring a dimension does
 * not revoke one; what `configured` reports is what the deployment alone would
 * allow, for a reader that has to show both numbers. The root's own
 * `acceptedAt` is unchanged by any of this: an approved deadline is an absolute
 * instant, never a longer window measured from a fresh "now".
 *
 * `reason` texts are recovery diagnostics: they say what is missing (no root,
 * no run bound to this store as its root, several such tasks, a root run with
 * no readable start) so an operator reading `task_status` knows why the tree
 * cannot be started under a budget instead of being handed a fabricated one.
 */
export function resolveRootBudget(snapshot: TaskSnapshot, config: RootBudgetConfig): RootBudgetResolution {
  const roots = snapshot.tasks.filter(task => task.parentTaskId === undefined)
  if (roots.length === 0) {
    return { ok: false, reason: `store ${snapshot.id} holds no root task (no task without a parentTaskId), so no budget owner exists; a budget is rooted in the store's own tree` }
  }
  const owners = roots.filter(task => boundRunOf(snapshot, task) !== undefined)
  if (owners.length === 0) {
    // A single parentless task with no run at all is the plainest gap: there is
    // no run whose start the budget could be measured from.
    if (roots.length === 1 && snapshot.runs.every(run => run.taskId !== roots[0]!.taskId)) {
      return { ok: false, reason: `root task ${roots[0]!.taskId} has no run recorded, so its budget has no start instant; a restart time is not a substitute for the run that accepted it` }
    }
    const named = roots.map(task => {
      const sessions = snapshot.runs.filter(run => run.taskId === task.taskId).map(run => run.sessionId)
      return `${task.taskId}${sessions.length === 0 ? '' : ` (session ${sessions.join(', ')})`}`
    })
    return {
      ok: false,
      reason:
        `store ${snapshot.id} holds ${roots.length === 1 ? 'a parentless task' : `${roots.length} parentless tasks`} ${named.join(', ')}, ` +
        `and none of their runs names this store's root session (a root run is bound to the session the store id ${snapshot.id} derives from, ` +
        "rootTaskStoreId), so no budget owner exists; a replay's parentless task shares the root's total and never claims one of its own",
    }
  }
  if (owners.length > 1) {
    return {
      ok: false,
      reason:
        `store ${snapshot.id} holds ${owners.length} tasks bound to this store as its root (${owners.map(task => task.taskId).join(', ')}), ` +
        'so no single budget owner exists; one store carries one tree, and a budget cannot be split over several',
    }
  }
  const root = owners[0] as TaskInstance
  const first = firstRun(snapshot, root, snapshot.id)
  if (first === undefined) {
    return { ok: false, reason: `root task ${root.taskId} has no run recorded, so its budget has no start instant; a restart time is not a substitute for the run that accepted it` }
  }
  const acceptedAtMs = instant(first.startedAt)
  if (acceptedAtMs === undefined) {
    return {
      ok: false,
      reason:
        `root task ${root.taskId}'s first run ${first.runId} records no readable startedAt (${JSON.stringify(first.startedAt)}), ` +
        'so the tree has no honest start instant and is not given a fresh one',
    }
  }
  const configured: RootBudgetCeilings = {
    ...(config.wallTimeMs === undefined ? {} : { deadlineAt: new Date(acceptedAtMs + config.wallTimeMs).toISOString() }),
    ...(config.maxRuns === undefined ? {} : { maxRuns: config.maxRuns }),
  }
  const approved = approvedBudgetCeilings(snapshot.budgetExtensions?.all ?? [])
  const maxRuns = approved.maxRuns ?? configured.maxRuns
  const deadlineAt = approved.deadlineAt ?? configured.deadlineAt
  return {
    ok: true,
    rootTaskId: root.taskId,
    acceptedAt: first.startedAt,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(maxRuns === undefined ? {} : { maxRuns }),
    configured,
  }
}

/** The run of `task` that is bound to `storeId` as a root run, or `undefined` when the task holds none. */
function boundRunOf(snapshot: TaskSnapshot, task: TaskInstance): TaskRun | undefined {
  return snapshot.runs.find(run => run.taskId === task.taskId && rootTaskStoreId(run.sessionId) === snapshot.id)
}

/** The root's first run: the run its own `runIds` names first, among the runs bound to this store as its root. */
function firstRun(snapshot: TaskSnapshot, task: TaskInstance, storeId: string): { runId: RunId; startedAt: string } | undefined {
  const bound = snapshot.runs.filter(run => run.taskId === task.taskId && rootTaskStoreId(run.sessionId) === storeId)
  const named = task.runIds.length > 0 ? bound.find(run => run.runId === task.runIds[0]) : undefined
  const run = named ?? bound[0]
  return run === undefined ? undefined : { runId: run.runId, startedAt: run.startedAt }
}

/**
 * Whether a run may start under the budget. Two refusals, in this order: the run
 * count has reached `maxRuns` (the limit is a count of what the store already
 * holds, so a restart cannot refund it), or the root deadline has arrived.
 */
export function checkRunStart(snapshot: TaskSnapshot, budget: ResolvedRootBudget, nowMs: number = Date.now()): BudgetVerdict {
  if (budget.maxRuns !== undefined && snapshot.runs.length >= budget.maxRuns) {
    return {
      allowed: false,
      reason:
        `the root budget allows ${budget.maxRuns} run(s) for root ${budget.rootTaskId} and the store already holds ${snapshot.runs.length}; ` +
        'the limit counts recorded runs so it cannot be reset by a restart',
    }
  }
  const deadline = instant(budget.deadlineAt)
  if (deadline !== undefined && nowMs >= deadline) {
    return {
      allowed: false,
      reason: `root ${budget.rootTaskId}'s deadline ${budget.deadlineAt} has passed (accepted at ${budget.acceptedAt}), so no new run starts under this budget`,
    }
  }
  return { allowed: true }
}

/**
 * Whether a decomposition batch of `childCount` children may be admitted. The
 * check is a reservation, not a forecast: the children will each start a run, so
 * a batch that would push the tree past `maxRuns` is refused whole — before a
 * task, a child or an event exists — rather than admitted and then started until
 * the budget runs out mid-batch.
 */
export function checkBatchAdmission(snapshot: TaskSnapshot, budget: ResolvedRootBudget, childCount: number): BudgetVerdict {
  if (budget.maxRuns === undefined) return { allowed: true }
  const total = snapshot.runs.length + childCount
  if (total > budget.maxRuns) {
    return {
      allowed: false,
      reason:
        `a batch of ${childCount} child task(s) would need ${childCount} run slot(s) and the root budget allows ${budget.maxRuns} run(s) ` +
        `in total, of which ${snapshot.runs.length} are already recorded (${total} > ${budget.maxRuns}); the batch is refused whole, with no side effects`,
    }
  }
  return { allowed: true }
}

/**
 * What is left of the tightest deadline that applies to a run, in milliseconds.
 *
 * `min` semantics over the bounds that can be in force: the run's own wall time
 * measured from its persisted `startedAt` (so a resumed run keeps the clock it
 * started with) and what is left of the root's deadline. A bound that has passed
 * returns 0 rather than a negative number, and `Infinity` means no bound at all
 * is configured.
 *
 * A bound whose instant cannot be read is treated as *reached* (`0`): a start
 * time nobody can parse is not a licence to run without a deadline, which is the
 * same discipline `resolveRootBudget` applies to a missing root start.
 */
export function runDeadlineMs(
  runStartedAt: string,
  perRunWallTimeMs: number | undefined,
  rootDeadlineAt: string | undefined,
  nowMs: number,
): number {
  const parts: number[] = []
  if (perRunWallTimeMs !== undefined) {
    const started = instant(runStartedAt)
    parts.push(started === undefined ? 0 : Math.max(0, started + perRunWallTimeMs - nowMs))
  }
  if (rootDeadlineAt !== undefined) {
    const deadline = instant(rootDeadlineAt)
    parts.push(deadline === undefined ? 0 : Math.max(0, deadline - nowMs))
  }
  return parts.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...parts)
}

/**
 * Refuse a root budget this deployment cannot execute. The one such limit is
 * `maxConcurrentWrites`: the workspace registry enforces exactly one writer, so
 * a configuration asking for any other number is a hard limit nobody can honor —
 * and §3.5's rule is that asking for an unenforceable hard limit refuses to
 * start rather than starting under a limit that is not real. Everything else
 * about the shape (unknown members, negative values) is the Config schema's
 * business, checked where the configuration is loaded.
 */
export function assertRootBudgetConfig(config: RootBudgetConfig): void {
  if (config.maxConcurrentWrites !== undefined && config.maxConcurrentWrites !== 1) {
    throw new Error(
      `rootBudget.maxConcurrentWrites is ${config.maxConcurrentWrites}: this deployment enforces exactly 1 concurrent writer per workspace, ` +
      'so it cannot honor another number and refuses to start rather than run under a limit it cannot execute',
    )
  }
}
