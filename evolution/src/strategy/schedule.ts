// RRSI strategy port — derived from google-research/rrsi @ be50316 (Apache-2.0),
// rrsi/schedule.py. Divergences are marked "plan §4 override" at each site and
// pinned by correction tests.

export interface EditBudgetPolicy { rounds: number; min: number; max: number }

function assertEditBudgetPolicy(policy: EditBudgetPolicy): void {
  if (!Number.isInteger(policy.rounds) || policy.rounds < 1)
    throw new Error(`EditBudgetPolicy.rounds: expected an integer >= 1, got ${policy.rounds}`)
  if (!Number.isInteger(policy.min) || policy.min < 1)
    throw new Error(`EditBudgetPolicy.min: expected an integer >= 1, got ${policy.min}`)
  if (!Number.isInteger(policy.max) || policy.max < policy.min)
    throw new Error(`EditBudgetPolicy.max: expected an integer >= min (${policy.min}), got ${policy.max}`)
}

/** 第 round 轮（0-based）允许的独立编辑数。
 *
 *  plan §4 override：上游 rrsi/schedule.py:48 的分母是 T，t 只取 0..T-1，因此末轮
 *  b(T-1) ≠ b_min（T=20,b_min=1,b_max=4 时 b(19)=2），上游靠越界端点 edit_budget(T,T,…)
 *  才等于 b_min。本移植分母为 rounds-1，table[rounds-1] === min 精确成立（plan §4
 *  「最后一轮确实为一项」），并消掉上游为掩盖浮点误差加的 round(v, 9) 保护。 */
export function editBudget(round: number, policy: EditBudgetPolicy): number {
  assertEditBudgetPolicy(policy)
  if (policy.rounds <= 1) return policy.min
  const t = Math.max(0, Math.min(Math.trunc(round), policy.rounds - 1))
  const v = policy.min + (policy.max - policy.min) * 0.5 * (1 + Math.cos(Math.PI * t / (policy.rounds - 1)))
  return Math.ceil(v)
}

export function editBudgetTable(policy: EditBudgetPolicy): readonly number[] {
  assertEditBudgetPolicy(policy)
  return Array.from({ length: policy.rounds }, (_, t) => editBudget(t, policy))
}
