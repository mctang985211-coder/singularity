import { describe, expect, test } from 'vitest'
import { JUDGED_DIMENSIONS } from '@dangosys/dsh-singularity-task'
import { REVIEW_AGENT_BUDGET_DEFAULT } from '../../src/coordination/ledger.ts'
import { DEFAULT_SUPERVISION } from '../../src/coordination/supervision.ts'
import { renderJudgementDimensions } from '../../src/tools/task-review-pack.ts'

/**
 * What is left of this module after A5 deleted the escalation derivation.
 *
 * `computeEscalation`'s thresholds (E1–E4), its `required`/`suppressed`
 * derivation and the pack's `escalation:` line had no consumer left once the
 * triggers were fixed: a review agent runs for an explicit call under the
 * store's own allowance, and never because a threshold the pack re-derived said
 * so. (The automatic scan that once accepted a terminal review on its own is
 * gone too — see F.) Two symbols keep a consumer and stay here:
 *
 * - `REVIEW_AGENT_BUDGET_DEFAULT`, the shipped per-root-store allowance the
 *   ledger counts against (`review-agent-ledger.ts:reviewAgentBudget`);
 * - `renderJudgementDimensions`, the pack's line naming the six dimensions no
 *   parser can settle, which the pack prints beside its facts.
 */

describe('the review-agent allowance', () => {
  test('defaults to eight started runs per root store, the supervision config default', () => {
    expect(REVIEW_AGENT_BUDGET_DEFAULT).toBe(8)
    expect(REVIEW_AGENT_BUDGET_DEFAULT).toBe(DEFAULT_SUPERVISION.coordinationBudget)
  })
})

describe('renderJudgementDimensions', () => {
  test('names the six judged dimensions and none of the mechanical two', () => {
    const line = renderJudgementDimensions()
    for (const dimension of JUDGED_DIMENSIONS) expect(line).toContain(dimension)
    expect(line).not.toContain('outcome_correctness')
    expect(line).not.toContain('capability_coverage')
    expect(line).toContain('not mechanically observable')
  })
})
