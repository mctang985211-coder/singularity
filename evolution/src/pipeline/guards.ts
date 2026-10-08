/**
 * The non-compensatory guards one evaluation is checked by: a declared token
 * ceiling against a reading that may be unknown, and nothing else — the
 * acceptance, holdout and domain guards come from the asset's own adapter.
 */

import { reportedTokensOf } from '../strategy/observe.ts'
import type { EvaluationPlan, GuardOutcome, TrialComparison } from '../types.ts'

/** The cost guard, when the plan declares a ceiling: an unknown reading refuses, and so does an overspend. */
export function costRefusal(plan: EvaluationPlan, trials: readonly TrialComparison[]): GuardOutcome | undefined {
  const ceiling = plan.budget.maxTokens
  if (ceiling === undefined) return undefined
  const spent: number[] = []
  for (const comparison of trials) {
    for (const side of ['baseline', 'candidate'] as const) {
      const total = reportedTokensOf(comparison[side].receipt.cost)
      if (total === undefined) {
        return {
          id: 'cost-ceiling',
          kind: 'domain',
          ok: false,
          detail:
            `the ${side} side of sample "${comparison.sampleTaskId}" reports no whole token reading while the plan declares a ceiling of ` +
            `${ceiling} tokens; an unknown cost is never counted as zero`,
        }
      }
      spent.push(total)
    }
  }
  const total = spent.reduce((sum, value) => sum + value, 0)
  if (total > ceiling) {
    return {
      id: 'cost-ceiling',
      kind: 'domain',
      ok: false,
      detail: `the evaluation spent ${total} tokens against the frozen ceiling of ${ceiling}`,
    }
  }
  return {
    id: 'cost-ceiling',
    kind: 'domain',
    ok: true,
    detail: `the evaluation spent ${total} tokens of the frozen ceiling of ${ceiling}`,
  }
}
