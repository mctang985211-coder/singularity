// RRSI strategy port — derived from google-research/rrsi @ be50316 (Apache-2.0),
// rrsi/{schedule,history,evaluate,calibrate,selection}.py. Divergences are marked
// "plan §4 override" at each site and pinned by correction tests.
import { createHash } from 'node:crypto'

/** 一次搜索使用的机制词表。与上游 K（rrsi/components.py:44）不同，机制不是根据 diff 正则猜出来的文件名信号，
 *  而是候选适配器按真实资产改动核验后的标签。 */
export const MECHANISM_KINDS = ['skill', 'capability', 'task-template', 'text', 'parameter'] as const
export type MechanismKind = (typeof MECHANISM_KINDS)[number]
/** 增加机器结构的机制（对应上游 K_STR，rrsi/components.py:46）。 */
export const STRUCTURAL_MECHANISM_KINDS: readonly MechanismKind[] = ['skill', 'capability', 'task-template']

/** plan §4 的搜索侧策略。随评估范围一起冻结，任何字段变化都换 scope。 */
export interface StrategyPolicy {
  version: 'rrsi-strategy@1'
  /** 搜索轮数 T，t = 0..T-1。 */
  rounds: number
  /** 每任务独立求解次数 k（plan §4「同版本独立求解至少三次」）。 */
  trials: number
  /** 每轮候选数 m。plan §4 首版为 1。 */
  candidatesPerRound: number
  /** L0 退火编辑预算端点：bundled 独立编辑数从 max 退火到 min。 */
  editBudget: { min: number; max: number }
  /** 停滞窗口与停滞时保留给未测机制的候选槽位数。 */
  stall: { window: number; reservedDrafts: number }
  noise: {
    /** δ = z · sd(null ΔS)。 */
    z: number
    /** plan §4 要求的最少独立重复求解次数；少于该值不得声称观察到噪声。 */
    minIndependentEvaluations: number
    /** 任务内 bootstrap 重采样次数与种子。 */
    bootstrapReps: number
    seed: number
    /** 观测不到任何噪声时的声明天花板（绝不用 0，plan §4「单 trial 不产生零噪声结论」）。 */
    floor: number
  }
  /** ΔS > δ 时的成本准入：ΔC ≤ min(base + slope·ΔS, maxRelativeIncrease)。 */
  cost: { baseAllowance: number; gainFundedIncrease: number; maxRelativeIncrease: number }
  /** 带内整形：成本必须至少改善 max(relativeCostBand, minRelief)。 */
  inBand: { minRelief: number }
  /** 首版无 novelty 放宽（plan §4）。 */
  noveltyRelaxation: false
  /** 近期收益窗口 n_prune（上游 rrsi/config.py:75）。 */
  pruneWindow: number
  /** 连续多少轮无有效质量增益就转向未测机制（plan §4：两轮）。 */
  stallRounds: number
  /** baseline admission refusal 的预先声明绝对成本上限（token）；0 表示部署未声明，
   *  未声明时 admission-refusal 候选一律拒绝，不允许伪造相对成本（plan §4）。 */
  baselineAdmissionCeilingTokens: number
  /** 评估前 critic：一次调用，无修补链（plan §4）。 */
  critic: 'required'
}

export const DEFAULT_STRATEGY_POLICY: StrategyPolicy = {
  version: 'rrsi-strategy@1',
  rounds: 20,
  trials: 3,
  candidatesPerRound: 1,
  editBudget: { min: 1, max: 2 },
  stall: { window: 2, reservedDrafts: 1 },
  noise: { z: 2.0, minIndependentEvaluations: 3, bootstrapReps: 2000, seed: 7, floor: 0.02 },
  cost: { baseAllowance: 0.10, gainFundedIncrease: 40, maxRelativeIncrease: 0.25 },
  inBand: { minRelief: 0.05 },
  noveltyRelaxation: false,
  pruneWindow: 4,
  stallRounds: 2,
  baselineAdmissionCeilingTokens: 0,
  critic: 'required',
}

/** plan §5 三臂对照的第二臂：同一条管线、正则化全部关闭。 */
export const UNREGULARIZED_STRATEGY_POLICY: StrategyPolicy = {
  ...DEFAULT_STRATEGY_POLICY,
  editBudget: { min: DEFAULT_STRATEGY_POLICY.editBudget.max, max: DEFAULT_STRATEGY_POLICY.editBudget.max },
  noise: { ...DEFAULT_STRATEGY_POLICY.noise, z: 0, floor: 0 },
  cost: { baseAllowance: 0, gainFundedIncrease: 0, maxRelativeIncrease: Number.POSITIVE_INFINITY },
  inBand: { minRelief: 0 },
  pruneWindow: 0,
  stallRounds: DEFAULT_STRATEGY_POLICY.rounds,
}

function fail(path: string, expected: string): never {
  throw new Error(`StrategyPolicy.${path}: expected ${expected}`)
}

function intAt(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) fail(path, `an integer >= ${min}`)
  return value
}

function numAt(value: unknown, path: string, min: number, exclusiveMin = false): number {
  if (typeof value !== 'number' || Number.isNaN(value)) fail(path, 'a number')
  if (exclusiveMin ? value <= min : value < min) fail(path, `a number ${exclusiveMin ? '>' : '>='} ${min}`)
  return value
}

export function assertStrategyPolicy(value: unknown): asserts value is StrategyPolicy {
  if (typeof value !== 'object' || value === null) fail('', 'an object')
  const p = value as Record<string, unknown>
  if (p.version !== 'rrsi-strategy@1') fail('version', "'rrsi-strategy@1'")
  intAt(p.rounds, 'rounds', 1)
  intAt(p.trials, 'trials', 1)
  intAt(p.candidatesPerRound, 'candidatesPerRound', 1)
  const eb = p.editBudget as Record<string, unknown> | null
  if (typeof eb !== 'object' || eb === null) fail('editBudget', 'an object')
  intAt(eb.min, 'editBudget.min', 1)
  intAt(eb.max, 'editBudget.max', 1)
  if ((eb.min as number) > (eb.max as number)) fail('editBudget', 'min <= max')
  const stall = p.stall as Record<string, unknown> | null
  if (typeof stall !== 'object' || stall === null) fail('stall', 'an object')
  intAt(stall.window, 'stall.window', 1)
  intAt(stall.reservedDrafts, 'stall.reservedDrafts', 0)
  const noise = p.noise as Record<string, unknown> | null
  if (typeof noise !== 'object' || noise === null) fail('noise', 'an object')
  numAt(noise.z, 'noise.z', 0)
  intAt(noise.minIndependentEvaluations, 'noise.minIndependentEvaluations', 1)
  intAt(noise.bootstrapReps, 'noise.bootstrapReps', 1)
  intAt(noise.seed, 'noise.seed', 0)
  numAt(noise.floor, 'noise.floor', 0)
  const cost = p.cost as Record<string, unknown> | null
  if (typeof cost !== 'object' || cost === null) fail('cost', 'an object')
  numAt(cost.baseAllowance, 'cost.baseAllowance', 0)
  numAt(cost.gainFundedIncrease, 'cost.gainFundedIncrease', 0)
  numAt(cost.maxRelativeIncrease, 'cost.maxRelativeIncrease', 0, true)
  const inBand = p.inBand as Record<string, unknown> | null
  if (typeof inBand !== 'object' || inBand === null) fail('inBand', 'an object')
  numAt(inBand.minRelief, 'inBand.minRelief', 0)
  if (p.noveltyRelaxation !== false) fail('noveltyRelaxation', 'false (首版无 novelty 放宽)')
  intAt(p.pruneWindow, 'pruneWindow', 0)
  intAt(p.stallRounds, 'stallRounds', 1)
  intAt(p.baselineAdmissionCeilingTokens, 'baselineAdmissionCeilingTokens', 0)
  if (p.critic !== 'required') fail('critic', "'required'")
}

/** 哪个正则器处于开启状态，进报告与对照实验分组。只做字段读取，判定路径没有 mode 分支。 */
export function regularizersActive(policy: StrategyPolicy): {
  editBudget: boolean; noiseFloor: boolean; costAdmission: boolean
  inBandShaping: boolean; stallSteering: boolean; pruning: boolean
} {
  return {
    editBudget: policy.editBudget.min !== policy.editBudget.max,
    noiseFloor: policy.noise.z > 0 && policy.noise.floor > 0,
    costAdmission: Number.isFinite(policy.cost.maxRelativeIncrease)
      || policy.cost.baseAllowance > 0 || policy.cost.gainFundedIncrease > 0,
    inBandShaping: policy.inBand.minRelief > 0,
    stallSteering: policy.stallRounds < policy.rounds,
    pruning: policy.pruneWindow > 0,
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value))
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`
}

/** 冻结策略的内容摘要：对字段变化敏感、对键顺序不敏感。policy.ts 不 import replay 的 digestOf，
 *  避免策略纯函数依赖 replay 实现；规范化规则与 replay/contract.ts 的 canonicalJson 同形。 */
export function strategyPolicyDigest(policy: StrategyPolicy): string {
  return createHash('sha256').update(canonical(policy)).digest('hex')
}
