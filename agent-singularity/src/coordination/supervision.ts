/** The supervision policy in force for this deployment — agent-singularity's `supervision` config, resolved once at plugin construction and read by the coordination ledger and the RSI loop driver. @module @dangosys/dsh-singularity-agent/supervision */

/**
 * The `supervision` block of agent-singularity's configuration, with every
 * member resolved. It carries the one knob this deployment still owns: the
 * coordination allowance. The per-source round caps a *store* runs under belong
 * to the graph whose RSI loop schedules it (see {@link graphImprovementCap}), and
 * the runtime's own constants are the backstop for a store without one.
 */
export interface SupervisionConfig {
  /** Review-agent runs (reviewers and the RSI loop's supervisors together) one root store may start. */
  readonly coordinationBudget: number
}

/** Eight coordination runs per store. */
export const DEFAULT_SUPERVISION: SupervisionConfig = {
  coordinationBudget: 8,
}

let current: SupervisionConfig = DEFAULT_SUPERVISION

/** One numeric member: a finite value at or above the floor, floored to a whole count; anything else reads as the default. */
function whole(value: number | undefined, fallback: number, floor: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor ? Math.floor(value) : fallback
}

/** Resolve and install the deployment's settings; absent members read as the shipped defaults. */
export function configureSupervision(config: Partial<SupervisionConfig> | undefined): SupervisionConfig {
  current = {
    coordinationBudget: whole(config?.coordinationBudget, DEFAULT_SUPERVISION.coordinationBudget, 1),
  }
  return current
}

/** The settings in force: the deployment's own, or the shipped defaults while none was configured. */
export function supervisionSettings(): SupervisionConfig {
  return current
}

/**
 * The round cap one graph's RSI settings declare for its root task store (F):
 * `rsi.iterationRounds` is how many rounds that graph's platform loop runs, and
 * the runtime's per-source cap has to admit exactly those. The platform driver
 * (`coordination/rsi-loop.ts`) registers a store when it takes the graph's loop
 * over and forgets it when the loop ends or the config is cleared; a store no
 * graph registers is not running a loop, and the runtime's own constant stands
 * for it unchanged. This process never reads the cap itself — it answers the
 * runtime's `singularitySupervision.maxImprovementRoundsFor` question.
 */
const graphRoundsCaps = new Map<string, number>()

/** Declare one store's round cap; the graph's own RSI round count is the only caller. */
export function registerGraphImprovementCap(storeId: string, rounds: number): void {
  if (!Number.isFinite(rounds) || rounds < 0) return
  graphRoundsCaps.set(storeId, Math.floor(rounds))
}

/** Forget one store's declared cap: its graph runs no RSI loop any more, so the runtime's constant stands again. */
export function unregisterGraphImprovementCap(storeId: string): void {
  graphRoundsCaps.delete(storeId)
}

/** The round cap a store's graph declares, or `undefined` when no graph runs an RSI loop over it. */
export function graphImprovementCap(storeId: string): number | undefined {
  return graphRoundsCaps.get(storeId)
}
