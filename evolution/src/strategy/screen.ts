// RRSI strategy port — derived from google-research/rrsi @ be50316 (Apache-2.0),
// rrsi/{propose,critic}.py 的评估前闸门语义。Divergences are marked
// "plan §4 override" at each site and pinned by correction tests.
import type { MechanismKind, StrategyPolicy } from './policy.ts'
import { editBudget } from './schedule.ts'

/** 候选声明的编辑。机制标签必须由候选适配器按真实资产改动核验（不是 diff 正则）。 */
export interface DeclaredEdit {
  id: string
  mechanism: MechanismKind
  hypothesis?: string
  /** 真实改动到的资产路径，由适配器核验后填入。 */
  targets: readonly string[]
  /** 声明机制未被真实改动佐证：该编辑不计入独立机制。 */
  mechanismUnverified?: boolean
}

/** 评估前的结构检查结果，由候选适配器产出（identity 一致、资产可加载、改动与声明相符、原验收未被换）。 */
export interface StructuralCheck { ok: boolean; findings: readonly string[] }

/** 一次独立 critic 的判定（plan §4：至多一次，无修补链；对照上游 critic.py 的 repair_rounds = 5）。 */
export interface CriticVerdict {
  verdict: 'accept' | 'reject'
  reason: string
  evidenceRefs: readonly string[]
  criticId: string
  at: string
}

export type ScreenRefusalCode =
  | 'over-budget' | 'no-independent-mechanism' | 'structure-failed'
  | 'critic-missing' | 'critic-reject'

export type Screen = { ok: true; bundleLevel: boolean } | { ok: false; reasonCode: ScreenRefusalCode; reason: string }

function refuse(reasonCode: ScreenRefusalCode, reason: string): Screen {
  return { ok: false, reasonCode, reason }
}

/** 评估前闸门：结构检查与 critic 都发生在任何测量之前，被拒绝的候选不消耗 replay
 *  预算、不进入 measured 历史（照抄 rrsi/history.py:113 的 measured() 语义）。
 *  独立编辑数 = 核验通过的编辑数，必须 1 ≤ n ≤ editBudget(round)（上游 propose.py
 *  的 ‖z‖₀ ≤ b_t 约束）。 */
export function screenBeforeMeasurement(input: {
  round: number
  edits: readonly DeclaredEdit[]
  structure: StructuralCheck
  critic?: CriticVerdict
  policy: StrategyPolicy
}): Screen {
  const verified = input.edits.filter((e) => e.mechanismUnverified !== true)
  const budget = editBudget(input.round, { rounds: input.policy.rounds, ...input.policy.editBudget })
  if (verified.length === 0)
    return refuse('no-independent-mechanism', `no verified independent edit: ${input.edits.length} declared, 0 verified`)
  if (verified.length > budget)
    return refuse('over-budget', `${verified.length} independent edits exceed the round ${input.round} L0 budget ${budget}`)
  if (!input.structure.ok)
    return refuse('structure-failed', `structural check failed: ${input.structure.findings.join('; ')}`)
  if (input.policy.critic === 'required' && input.critic === undefined)
    return refuse('critic-missing', 'policy requires one independent critic verdict before measurement')
  if (input.critic !== undefined && input.critic.verdict === 'reject')
    return refuse('critic-reject', `critic ${input.critic.criticId} rejected: ${input.critic.reason}`)
  return { ok: true, bundleLevel: verified.length > 1 }
}
