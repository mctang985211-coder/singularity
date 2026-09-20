/**
 * When a review needs an agent, as a machine criterion (§2.7.2/§2.7.3).
 *
 * The fact table a `ReviewRecord` carries settles only two of the eight review
 * dimensions mechanically: `outcome_correctness` tallies the verifier's own
 * verdicts and `capability_coverage` reports the admission-time closure. The
 * other six — task specification, acceptance, decomposition, skill fit, tool
 * fit, context efficiency — are conclusions no parser can extract from a
 * complex context, and §2.7.2 permits spawning a review agent exactly for the
 * hard cases, never one per task. This module is the trigger: a pure function
 * over the store snapshot, so whether to escalate is decided by data and the
 * decision is testable without a live model.
 *
 * The four signals, each a fact already on the record (never a score):
 * - E1 the task's latest review settled `failed`;
 * - E2 that failure left no log tail and no evidence refs — the record says
 *   something went wrong but not where, so localization needs a reader;
 * - E3 a criterion came back `inconclusive` — the verifier itself could not
 *   give a true/false, which is precisely a judgement call. The record's
 *   criteria carry `unknownKind` to keep the two unknowns apart (KISS §4.3):
 *   `task` means the check never ran (timeout, the command never started) and
 *   the follow-up is to re-test or gather evidence; `verifier` means the
 *   judge is broken (it threw, or none supports the mode) and the follow-up
 *   is to fix the verifier first — confusing the two re-tests the same thing
 *   forever;
 * - E4 capability coverage closed as a `gap`, or the manifest names missing
 *   capabilities — the failure may be a tooling hole, not a task defect.
 *
 * The budget guardrail is applied here too, but its count is supplied by the
 * caller (the ledger under `$DSH_HOME` owns the number); this function stays
 * pure so every branch is unit-testable.
 * @module @dangosys/dsh-singularity-agent/tools/review-escalation
 */

import { JUDGED_DIMENSIONS } from '@dangosys/dsh-singularity-task'
import type { ReviewRecord, TaskId, TaskSnapshot } from '@dangosys/dsh-singularity-task'

/** The four escalation signals, in the order they are reported. */
export type EscalationReason = 'E1' | 'E2' | 'E3' | 'E4'

/** Every signal, in report order. */
export const ESCALATION_REASONS: readonly EscalationReason[] = ['E1', 'E2', 'E3', 'E4']

/** How many review agents one root store may start before the guardrail holds. */
export const REVIEW_AGENT_BUDGET_DEFAULT = 1

export interface EscalationBudget {
  /** Review agents this root store has already started (from the ledger). */
  used: number
  /** The cap; `REVIEW_AGENT_BUDGET_DEFAULT` when the caller passes none. */
  max: number
}

export interface Escalation {
  /** Signals whose data holds for this task, in {@link ESCALATION_REASONS} order. */
  reasons: EscalationReason[]
  /** True only when at least one signal holds and the budget still has room. */
  required: boolean
  budget: EscalationBudget
  /** Signals that held but were withheld because the budget was spent. */
  suppressed: EscalationReason[]
}

function latestReview(snapshot: TaskSnapshot, taskId: TaskId): ReviewRecord | undefined {
  return [...snapshot.reviews].reverse().find(item => item.taskId === taskId)
}

/**
 * The capability coverage of one task, read from the review's dimension facts
 * when present and from the stored admission manifest otherwise. Both describe
 * the same resolution; the review's copy is the one a reader sees, the stored
 * manifest is what exists for a runless or dimension-less record.
 */
function capabilityGap(snapshot: TaskSnapshot, taskId: TaskId, review: ReviewRecord | undefined): boolean {
  const coverage = review?.dimensions?.capabilityCoverage
  if (coverage !== undefined) return coverage.closure === 'gap' || coverage.missing.length > 0
  const manifest = snapshot.capabilities[taskId]
  if (manifest === undefined) return false
  return manifest.closure === 'gap' || manifest.missing.length > 0
}

/**
 * Compute the escalation decision for one task against a store snapshot.
 * @param snapshot - the root task store snapshot.
 * @param taskId - the task whose review is under consideration.
 * @param budget - review agents already started, and the cap (defaults to
 *   `used: 0, max: REVIEW_AGENT_BUDGET_DEFAULT`).
 * @returns the signals that hold, whether to escalate, and the budget state.
 */
export function computeEscalation(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  budget: { used?: number; max?: number } = {},
): Escalation {
  const resolved: EscalationBudget = {
    used: Math.max(0, budget.used ?? 0),
    max: Math.max(1, budget.max ?? REVIEW_AGENT_BUDGET_DEFAULT),
  }
  const review = latestReview(snapshot, taskId)
  const reasons: EscalationReason[] = []
  if (review?.outcome === 'failed') {
    reasons.push('E1')
    if (review.logTail === undefined && review.evidenceRefs.length === 0) reasons.push('E2')
  }
  // E3 fires on any inconclusive; `unknownKind` on the criterion (see the
  // module header) says which follow-up the escalation should pursue.
  if ((review?.criteria ?? []).some(criterion => criterion.verdict === 'inconclusive')) reasons.push('E3')
  if (capabilityGap(snapshot, taskId, review)) reasons.push('E4')
  const exhausted = reasons.length > 0 && resolved.used >= resolved.max
  return {
    reasons,
    required: reasons.length > 0 && !exhausted,
    budget: resolved,
    suppressed: exhausted ? reasons : [],
  }
}

/**
 * The machine-readable escalation line `task_review_pack` prints. Three shapes:
 * required with signals, not required, and not required because the guardrail
 * spent the budget (which still names what it withheld — a suppressed signal is
 * a fact, not a silence).
 */
export function renderEscalation(escalation: Escalation): string {
  const budget = `${escalation.budget.used}/${escalation.budget.max}`
  if (escalation.required) return `escalation: required ${escalation.reasons.join(', ')} (budget ${budget})`
  if (escalation.suppressed.length > 0) {
    return `escalation: not required (budget ${budget}) — suppressed ${escalation.suppressed.join(', ')}: budget exhausted`
  }
  return `escalation: not required (budget ${budget})`
}

/**
 * The judgement line: the six dimensions whose conclusion the fact table does
 * not carry, named so a reader cannot mistake the facts for a verdict.
 */
export function renderJudgementDimensions(): string {
  return `needs judgement (agent): ${JUDGED_DIMENSIONS.join(', ')} (not mechanically observable from the fact table; task_review_agent concludes these)`
}
