// RRSI strategy port — derived from google-research/rrsi @ be50316 (Apache-2.0),
// rrsi/selection.py (Algorithm 2). Divergences are marked "plan §4 override" at
// each site and pinned by correction tests.
import type { MechanismKind, StrategyPolicy } from './policy.ts'
import { STRUCTURAL_MECHANISM_KINDS } from './policy.ts'
import type { AggregateScore, NoiseCalibration } from './measure.ts'
import type { DeclaredEdit, ScreenRefusalCode } from './screen.ts'

export interface CandidateMeasurement {
  candidateId: string
  /** 候选完整内容摘要；同字节候选靠它直接结案。 */
  contentDigest: string
  /** 本条测量所属的冻结 scope。 */
  scope: string
  edits: readonly DeclaredEdit[]
  /** 未评估（被 screen 拒绝、或本轮无预算）时为 undefined。 */
  aggregate?: AggregateScore
  /** 运行时的 admission refusal（能力缺失的 baseline 侧），带预先声明的绝对成本。 */
  admissionRefusal?: {
    source: 'capability-gap' | 'provider-refused'
    /** 声明为拒绝该侧所使用的绝对 token 上限；不是从被测侧推算出的相对值。 */
    ceilingTokens: number
    /** 该侧实际消耗，缺席即无法判定。 */
    spentTokens?: number
  }
  /** 未评估时的拒绝码，进历史与紧凑摘要。 */
  refusedBy?: ScreenRefusalCode
}

export type AdmissionReasonCode =
  | 'admissible'
  | 'not-measured' | 'scope-mismatch'
  | 'below-floor'
  | 'quality-inconclusive' | 'cost-inconclusive'
  | 'cost-rule-failed' | 'in-band-no-relief'
  | 'guard-violated'
  | 'refused-admission-baseline'

export interface Admission {
  candidateId: string
  admissible: boolean
  reasonCode: AdmissionReasonCode
  reason: string
  quality?: number
  cost?: number
  deltaQuality?: number
  /** 相对成本变化；任一侧成本未知时为 undefined，绝不置 0（plan §4 override：
   *  上游 rrsi/evaluate.py:131 在同样输入下返回 0，成本准入静默恒真）。 */
  deltaCost?: number
  novelty: number
  bundleLevel: boolean
  guards: readonly string[]
}

/** 结构性机制新颖度，对应上游 rrsi/components.py:103：候选触到的、 incumbent 从未
 *  接受过编辑的结构性机制数。只作记录与 selectRound 的确定性 tie-break，不放宽准入。 */
export function noveltyOf(
  mechanisms: readonly MechanismKind[],
  incumbentCounts: Readonly<Partial<Record<MechanismKind, number>>>,
): number {
  const seen = new Set(mechanisms)
  return STRUCTURAL_MECHANISM_KINDS.filter((k) => seen.has(k) && (incumbentCounts[k] ?? 0) === 0).length
}

/** 上游 cost_rule:81 的 TS 版。plan §4 override：
 *  - 增益分支追加 maxRelativeIncrease = 25% 硬上限（plan §4「默认上限 25% 且受收益约束」）；
 *  - 任一侧成本未知 → cost-inconclusive 拒绝，不按上游 ΔC = 0 放行；
 *  - 带内只认成本改善 ≥ max(relativeCostBand, minRelief)，novelty 不参与放宽
 *    （plan §4「首版无 novelty 放宽」，上游 selection.py:90 的 +w_n·ν 项删除）。 */
export function costRule(
  deltaQuality: number, deltaCost: number | undefined, novelty: number,
  calibration: NoiseCalibration, policy: StrategyPolicy,
): { ok: boolean; reasonCode: AdmissionReasonCode; reason: string } {
  void novelty
  if (deltaQuality > calibration.qualityBand) {
    const budget = Math.min(
      policy.cost.baseAllowance + policy.cost.gainFundedIncrease * deltaQuality,
      policy.cost.maxRelativeIncrease,
    )
    if (deltaCost === undefined)
      return { ok: false, reasonCode: 'cost-inconclusive', reason: `cost unknown for a gaining candidate (gain ${deltaQuality.toFixed(4)} > band ${calibration.qualityBand.toFixed(4)}); refusing instead of assuming dC = 0` }
    const ok = deltaCost <= budget
    return {
      ok, reasonCode: ok ? 'admissible' : 'cost-rule-failed',
      reason: `gain ${deltaQuality.toFixed(4)} > band ${calibration.qualityBand.toFixed(4)}; cost change ${deltaCost.toFixed(3)} ${ok ? '<=' : '>'} budget ${budget.toFixed(3)} (min(base ${policy.cost.baseAllowance} + slope ${policy.cost.gainFundedIncrease} * dS, cap ${policy.cost.maxRelativeIncrease}))`,
    }
  }
  const relief = Math.max(calibration.relativeCostBand, policy.inBand.minRelief)
  if (deltaCost === undefined)
    return { ok: false, reasonCode: 'cost-inconclusive', reason: `cost unknown for an in-band candidate (|gain| <= band ${calibration.qualityBand.toFixed(4)}); refusing instead of assuming dC = 0` }
  const ok = deltaCost <= -relief
  return {
    ok, reasonCode: ok ? 'admissible' : 'in-band-no-relief',
    reason: `gain ${deltaQuality.toFixed(4)} within band ${calibration.qualityBand.toFixed(4)}; cost change ${deltaCost.toFixed(3)} must be <= -max(cost band ${calibration.relativeCostBand.toFixed(3)}, min relief ${policy.inBand.minRelief}) = ${(-relief).toFixed(3)}`,
  }
}

function reject(candidateId: string, reasonCode: AdmissionReasonCode, reason: string, partial: Partial<Admission> = {}): Admission {
  return { candidateId, admissible: false, reasonCode, reason, novelty: 0, bundleLevel: false, guards: [], ...partial }
}

export function admit(input: {
  candidate: CandidateMeasurement
  incumbent: AggregateScore
  /** incumbent 所属的冻结 scope；与 candidate.scope 不一致即 scope-mismatch。 */
  incumbentScope: string
  /** 同一冻结 scope 的历史最佳质量（plan §4 的 floor）。 */
  bestQuality: number
  calibration: NoiseCalibration
  /** incumbent 已接受编辑的机制计数（novelty 的唯一用途是记录与 tie-break）。 */
  incumbentMechanismCounts?: Readonly<Partial<Record<MechanismKind, number>>>
  /** 领域非补偿守卫（原验收、holdout、能力消费），非空即拒绝。 */
  guards: readonly string[]
  policy: StrategyPolicy
}): Admission {
  const { candidate, incumbent, calibration, policy } = input
  const verified = candidate.edits.filter((e) => e.mechanismUnverified !== true)
  const novelty = noveltyOf(verified.map((e) => e.mechanism), input.incumbentMechanismCounts ?? {})
  const bundleLevel = verified.length > 1
  const base = { novelty, bundleLevel, guards: input.guards }
  if (candidate.scope !== input.incumbentScope)
    return reject(candidate.candidateId, 'scope-mismatch', `candidate scope ${candidate.scope} differs from the frozen incumbent scope ${input.incumbentScope}`, base)
  const aggregate = candidate.aggregate
  if (aggregate === undefined)
    return reject(candidate.candidateId, 'not-measured', candidate.refusedBy ?? 'not evaluated', base)
  const quality = aggregate.quality
  const cost = aggregate.cost
  const deltaQuality = quality - incumbent.quality
  const deltaCost = cost !== undefined && incumbent.cost !== undefined && incumbent.cost > 0
    ? (cost - incumbent.cost) / incumbent.cost
    : undefined
  const measured = { ...base, quality, cost, deltaQuality, deltaCost }
  if (candidate.admissionRefusal !== undefined) {
    const refusal = candidate.admissionRefusal
    if (refusal.spentTokens === undefined)
      return reject(candidate.candidateId, 'cost-inconclusive', `admission-refusal side (${refusal.source}) reported no spend; cannot check the declared ceiling`, measured)
    if (policy.baselineAdmissionCeilingTokens <= 0 || refusal.ceilingTokens > policy.baselineAdmissionCeilingTokens)
      return reject(candidate.candidateId, 'refused-admission-baseline', `declared ceiling ${refusal.ceilingTokens} tokens is not authorized by the frozen policy ceiling ${policy.baselineAdmissionCeilingTokens}`, measured)
    if (refusal.spentTokens > refusal.ceilingTokens)
      return reject(candidate.candidateId, 'refused-admission-baseline', `admission-refusal side spent ${refusal.spentTokens} tokens, above the declared absolute ceiling ${refusal.ceilingTokens}`, measured)
    if (input.guards.length > 0)
      return reject(candidate.candidateId, 'guard-violated', `domain guard violated: ${input.guards.join('; ')}`, measured)
    return { candidateId: candidate.candidateId, admissible: true, reasonCode: 'admissible', reason: `admissible: admission-refusal side spent ${refusal.spentTokens} <= declared ceiling ${refusal.ceilingTokens} tokens (absolute path, no relative cost fabricated)`, ...measured }
  }
  if (aggregate.missing > 0)
    return reject(candidate.candidateId, 'quality-inconclusive', `${aggregate.missing} trial(s) missing or inconclusive out of ${aggregate.expected}; original acceptance cannot be compensated`, measured)
  const floor = input.bestQuality - calibration.qualityBand
  if (quality < floor)
    return reject(candidate.candidateId, 'below-floor', `below noise-adjusted floor: quality ${quality.toFixed(4)} < best ${input.bestQuality.toFixed(4)} - band ${calibration.qualityBand.toFixed(4)}`, measured)
  if (input.guards.length > 0)
    return reject(candidate.candidateId, 'guard-violated', `domain guard violated: ${input.guards.join('; ')}`, measured)
  const rule = costRule(deltaQuality, deltaCost, novelty, calibration, policy)
  if (!rule.ok)
    return reject(candidate.candidateId, rule.reasonCode, `${rule.reasonCode === 'cost-inconclusive' ? 'cost inconclusive' : rule.reasonCode === 'in-band-no-relief' ? 'in-band candidate without sufficient cost relief' : 'cost rule failed'}: ${rule.reason}`, measured)
  return { candidateId: candidate.candidateId, admissible: true, reasonCode: 'admissible', reason: `admissible: ${rule.reason}`, ...measured }
}

/** 多候选时取 admissible 中质量最高；首版 m=1，保留形态供对照实验使用。
 *  质量相同的确定性 tie-break：novelty 高者优先，bundleLevel 候选劣后，最后按 candidateId。 */
export function selectRound(input: {
  candidates: readonly CandidateMeasurement[]
  incumbent: AggregateScore
  incumbentScope: string
  bestQuality: number
  calibration: NoiseCalibration
  incumbentMechanismCounts?: Readonly<Partial<Record<MechanismKind, number>>>
  guardsFor: (candidate: CandidateMeasurement) => readonly string[]
  policy: StrategyPolicy
}): { winner?: CandidateMeasurement; admissions: readonly Admission[] } {
  const admissions = input.candidates.map((candidate) => admit({
    candidate, incumbent: input.incumbent, incumbentScope: input.incumbentScope,
    bestQuality: input.bestQuality, calibration: input.calibration,
    incumbentMechanismCounts: input.incumbentMechanismCounts,
    guards: input.guardsFor(candidate), policy: input.policy,
  }))
  const better = (a: Admission, b: Admission): boolean => {
    const qa = a.quality ?? -1
    const qb = b.quality ?? -1
    if (qa !== qb) return qa > qb
    if (a.novelty !== b.novelty) return a.novelty > b.novelty
    if (a.bundleLevel !== b.bundleLevel) return !a.bundleLevel
    return a.candidateId < b.candidateId
  }
  let winner: CandidateMeasurement | undefined
  let best: Admission | undefined
  for (const [i, admission] of admissions.entries()) {
    if (!admission.admissible) continue
    if (best === undefined || better(admission, best)) {
      best = admission
      winner = input.candidates[i]
    }
  }
  return { winner, admissions }
}
