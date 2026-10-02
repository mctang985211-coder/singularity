/** The supervision policy in force for this deployment — agent-singularity's `supervision` config, resolved once at plugin construction and read by the triggers, the ledger and the tools. @module @dangosys/dsh-singularity-agent/supervision */

import type { TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'

/** When the automatic trigger accepts a terminal review for diagnosis. */
export type AutoReviewMode = 'all' | 'failed' | 'off'

/** The `supervision` block of agent-singularity's configuration, with every member resolved. */
export interface SupervisionConfig {
  /** `all` accepts every terminal review (failed and verified), `failed` only failures, `off` none. */
  readonly autoReview: AutoReviewMode
  /** Recovery attempts one failed source accepts before `iteration-cap`. */
  readonly maxRecoveryRounds: number
  /** Improvement attempts one verified source accepts before `iteration-cap`. */
  readonly maxImprovementRounds: number
  /** Review-agent runs (reviewers and supervisors together) one root store may start. */
  readonly coordinationBudget: number
}

/** The shipped defaults: failed reviews are diagnosed, three recovery rounds, two improvement rounds, eight coordination runs per store. */
export const DEFAULT_SUPERVISION: SupervisionConfig = {
  autoReview: 'failed',
  maxRecoveryRounds: 3,
  maxImprovementRounds: 2,
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
    autoReview: config?.autoReview ?? DEFAULT_SUPERVISION.autoReview,
    maxRecoveryRounds: whole(config?.maxRecoveryRounds, DEFAULT_SUPERVISION.maxRecoveryRounds, 0),
    maxImprovementRounds: whole(config?.maxImprovementRounds, DEFAULT_SUPERVISION.maxImprovementRounds, 0),
    coordinationBudget: whole(config?.coordinationBudget, DEFAULT_SUPERVISION.coordinationBudget, 1),
  }
  return current
}

/** The settings in force: the deployment's own, or the shipped defaults while none was configured. */
export function supervisionSettings(): SupervisionConfig {
  return current
}

/** The rounds one hand-off's source has already spent, as the store's own runs record them. */
export interface SupervisionRounds {
  /** The source review's outcome: a verified source spends improvement rounds, everything else recovery rounds. */
  readonly outcome: string
  readonly recovered: number
  readonly improved: number
  readonly maxRecovery: number
  readonly maxImprovement: number
}

/** `recovery` unless the run carries `improvement`; a row written before the field existed reads as a recovery. */
function kindOf(run: TaskRun): 'recovery' | 'improvement' {
  return run.recovery?.kind === 'improvement' ? 'improvement' : 'recovery'
}

/** The rounds one task has spent, counted from its own runs — the store's `TaskInstance.runIds` holds them all. */
export function sourceRoundsOf(snapshot: TaskSnapshot, taskId: string, outcome: string): SupervisionRounds {
  const runs = snapshot.runs.filter(run => run.taskId === taskId && run.recovery !== undefined)
  const settings = supervisionSettings()
  return {
    outcome,
    recovered: runs.filter(run => kindOf(run) === 'recovery').length,
    improved: runs.filter(run => kindOf(run) === 'improvement').length,
    maxRecovery: settings.maxRecoveryRounds,
    maxImprovement: settings.maxImprovementRounds,
  }
}

/** The refusal a source that has spent its rounds gets, or nothing while another round is allowed. */
export function roundCapRefusal(rounds: SupervisionRounds): { readonly code: 'iteration-cap'; readonly reason: string } | undefined {
  if (rounds.outcome === 'verified') {
    if (rounds.improved < rounds.maxImprovement) return undefined
    return {
      code: 'iteration-cap',
      reason:
        `the source's improvement rounds are spent (${rounds.improved}/${rounds.maxImprovement}) — a verified source accepts improvement ` +
        'attempts only until the cap, so nothing was started and no supervisor is delegated for it',
    }
  }
  if (rounds.recovered < rounds.maxRecovery) return undefined
  return {
    code: 'iteration-cap',
    reason:
      `the source's recovery rounds are spent (${rounds.recovered}/${rounds.maxRecovery}) — a failed source accepts recovery attempts ` +
      'only until the cap, so nothing was started and no supervisor is delegated for it',
  }
}
