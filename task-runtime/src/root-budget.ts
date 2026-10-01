import type { RunId, TaskId, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { approvedBudgetCeilings, rootTaskStoreId } from '@dangosys/dsh-singularity-task'

/**
 * The root budget as configured (`Config.rootBudget`). Every member is optional:
 * absent means the deployment sets no such limit, which is a statement about
 */
export interface RootBudgetConfig {
  /** How many runs the tree may start, counted over the store's whole run list. */
  maxRuns?: number
  /**
   * Writes that may hold one workspace at a time. This deployment enforces
   * exactly one, so any other value is a limit it cannot honor — see
   */
  maxConcurrentWrites?: number
}

/**
 * The run ceiling a root budget is measured in. Every member is optional, and
 * absent means the deployment sets no such limit — which is a statement about
 */
export interface RootBudgetCeilings {
  /** The run count the tree may reach. */
  readonly maxRuns?: number
}

/** Persisted budget owner, observed start time, and run ceilings. */
export interface ResolvedRootBudget {
  /** The store's root task (`parentTaskId === undefined`) — the tree the budget belongs to. */
  readonly rootTaskId: TaskId
  /** The root run's persisted start, read from the store: the instant the budget was accepted. */
  readonly acceptedAt: string
  /** The run ceiling in force: the approved absolute count when the store holds one, else the configured count. */
  readonly maxRuns?: number
  /** What the deployment itself configures, resolved against the same root start: the values before any approved raise. */
  readonly configured: RootBudgetCeilings
}

type RootBudgetResolution =
  ({ readonly ok: true } & ResolvedRootBudget) | { readonly ok: false; readonly reason: string }

/**
 * Whether a root budget enforces anything at all. The configuration's schema
 * materializes an absent `rootBudget` as an empty object, so the presence of an
 */
export function hasRootLimits(config: RootBudgetConfig | undefined): boolean {
  return config !== undefined && (config.maxRuns !== undefined || config.maxConcurrentWrites !== undefined)
}

/** The verdict a start or a batch admission gets. A refusal always names the limit it hit. */
type BudgetVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

function instant(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The root budget a snapshot is under, or the reason none can be measured.
 * The owner is the store's own root: among the parentless tasks, the one whose
 */
export function resolveRootBudget(snapshot: TaskSnapshot, config: RootBudgetConfig): RootBudgetResolution {
  const roots = snapshot.tasks.filter(task => task.parentTaskId === undefined)
  if (roots.length === 0) {
    return {
      ok: false,
      reason: `store ${snapshot.id} holds no root task (no task without a parentTaskId), so no budget owner exists; a budget is rooted in the store's own tree`,
    }
  }
  const owners = roots.filter(task => boundRunOf(snapshot, task) !== undefined)
  if (owners.length === 0) {
    // A single parentless task with no run at all is the plainest gap: there is
    // no run whose start the budget could be measured from.
    if (roots.length === 1 && snapshot.runs.every(run => run.taskId !== roots[0]!.taskId)) {
      return {
        ok: false,
        reason: `root task ${roots[0]!.taskId} has no run recorded, so its budget has no start instant; a restart time is not a substitute for the run that accepted it`,
      }
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
    return {
      ok: false,
      reason: `root task ${root.taskId} has no run recorded, so its budget has no start instant; a restart time is not a substitute for the run that accepted it`,
    }
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
    ...(config.maxRuns === undefined ? {} : { maxRuns: config.maxRuns }),
  }
  const approved = approvedBudgetCeilings(snapshot.budgetExtensions?.all ?? [])
  const maxRuns = approved.maxRuns ?? configured.maxRuns
  return {
    ok: true,
    rootTaskId: root.taskId,
    acceptedAt: first.startedAt,
    ...(maxRuns === undefined ? {} : { maxRuns }),
    configured,
  }
}

/** The run of `task` that is bound to `storeId` as a root run, or `undefined` when the task holds none. */
function boundRunOf(snapshot: TaskSnapshot, task: TaskInstance): TaskRun | undefined {
  return snapshot.runs.find(run => run.taskId === task.taskId && rootTaskStoreId(run.sessionId) === snapshot.id)
}

/** The root's first run: the run its own `runIds` names first, among the runs bound to this store as its root. */
function firstRun(
  snapshot: TaskSnapshot,
  task: TaskInstance,
  storeId: string,
): { runId: RunId; startedAt: string } | undefined {
  const bound = snapshot.runs.filter(run => run.taskId === task.taskId && rootTaskStoreId(run.sessionId) === storeId)
  const named = task.runIds.length > 0 ? bound.find(run => run.runId === task.runIds[0]) : undefined
  const run = named ?? bound[0]
  return run === undefined ? undefined : { runId: run.runId, startedAt: run.startedAt }
}

/**
 * Whether the persisted run count leaves room for another run.
 */
export function checkRunStart(snapshot: TaskSnapshot, budget: ResolvedRootBudget): BudgetVerdict {
  if (budget.maxRuns !== undefined && snapshot.runs.length >= budget.maxRuns) {
    return {
      allowed: false,
      reason:
        `the root budget allows ${budget.maxRuns} run(s) for root ${budget.rootTaskId} and the store already holds ${snapshot.runs.length}; ` +
        'the limit counts recorded runs so it cannot be reset by a restart',
    }
  }
  return { allowed: true }
}

/**
 * Whether a decomposition batch of `childCount` children may be admitted. The
 * check is a reservation, not a forecast: the children will each start a run, so
 */
export function checkBatchAdmission(
  snapshot: TaskSnapshot,
  budget: ResolvedRootBudget,
  childCount: number,
): BudgetVerdict {
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
 * Refuse a root budget this deployment cannot execute. The one such limit is
 * `maxConcurrentWrites`: the workspace registry enforces exactly one writer, so
 */
export function assertRootBudgetConfig(config: RootBudgetConfig): void {
  if (config.maxConcurrentWrites !== undefined && config.maxConcurrentWrites !== 1) {
    throw new Error(
      `rootBudget.maxConcurrentWrites is ${config.maxConcurrentWrites}: this deployment enforces exactly 1 concurrent writer per workspace, ` +
        'so it cannot honor another number and refuses to start rather than run under a limit it cannot execute',
    )
  }
}
