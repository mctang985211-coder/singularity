/**
 * What is left of the review-side escalation rules (A5).
 *
 * This module used to hold the escalation derivation: four threshold signals (a
 * failed review, a failure without a log tail, an inconclusive criterion, a
 * capability gap), a required/suppressed decision over them, the pack's
 * escalation line, and a budget that suppressed a signal the store had no room
 * to act on. A5 deleted all of it, because the derivation had no consumer left:
 * what makes a review agent run is a **trigger** — a review that settled `failed`
 * (accepted by the scan under the store's own allowance), or an explicit
 * `task_review_agent` call — and neither is a threshold the fact table
 * re-derives. Keeping the derivation would have left a second, silently
 * different trigger policy beside the real one.
 *
 * The raw observations the signals rested on were never this module's: they are
 * the review record's own fields (the outcome, the criteria, the log tail, the
 * evidence refs, the capability coverage) and the pack prints them directly.
 * Two symbols keep their consumers and stay:
 *
 * - {@link REVIEW_AGENT_BUDGET_DEFAULT} — the per-root-store allowance
 *   `review-agent-ledger.ts` counts against, overridable through
 *   `SINGULARITY_REVIEW_AGENT_BUDGET`;
 * - {@link renderJudgementDimensions} — the pack's line naming the six
 *   dimensions no parser can settle, which is what a review *is* for.
 * @module @dangosys/dsh-singularity-agent/tools/review-escalation
 */

import { JUDGED_DIMENSIONS } from '@dangosys/dsh-singularity-task'

/** How many review agents one root store may start before the guardrail holds. */
export const REVIEW_AGENT_BUDGET_DEFAULT = 1

/**
 * The judgement line: the six dimensions whose conclusion the fact table does
 * not carry, named so a reader cannot mistake the facts for a verdict. It names
 * what needs judgement, never whether one will run — that is the triggers' and
 * the store's allowance decision.
 */
export function renderJudgementDimensions(): string {
  return `needs judgement (agent): ${JUDGED_DIMENSIONS.join(', ')} (not mechanically observable from the fact table; a review agent may conclude them)`
}
