// RRSI strategy port — derived from google-research/rrsi @ be50316 (Apache-2.0),
// rrsi/{evaluate,calibrate}.py. Divergences are marked "plan §4 override" at each
// site and pinned by correction tests.
import type { StrategyPolicy } from './policy.ts'

/** 一次 trial 的折后观测。 */
export interface TrialObservation { quality: number; weight: number; tokens?: number }

/** 一个任务下同一侧的全部 trial。missing 的 trial 以 quality 0、权重不变占据分母。 */
export interface TaskMeasurement { taskId: string; trials: readonly TrialObservation[] }

/** 一次独立求解（上游 EvalResult 的可比子集）。 */
export interface EvaluationMeasurement {
  /** 冻结评估范围身份：同一 scope 才可比较、才可聚合重复。 */
  scope: string
  /** 本次冻结的每任务 trial 数 k。 */
  trials: number
  tasks: readonly TaskMeasurement[]
  /** 运行期从未落地的 trial（崩溃 / 超时 / 基础设施），每个记 0 且占满分母（plan §4）。 */
  missing: number
}

export interface AggregateScore {
  /** Ŝ ∈ [0,1]，判据加权成功率。 */
  quality: number
  /** Ĉ = 已知正成本 trial 的均值；全部未知时 undefined（绝不当 0）。 */
  cost?: number
  /** 冻结分母 |D|·k。 */
  expected: number
  missing: number
  /** 任一 trial 缺失或缺成本。 */
  incomplete: boolean
}

/** 聚合口径照抄 rrsi/evaluate.py:104-119：缺失 slot 以 r = 0 计入，分母不减。 */
export function aggregateEvaluation(input: EvaluationMeasurement): AggregateScore {
  let num = 0
  let den = 0
  let costSum = 0
  let costCount = 0
  let costUnknown = false
  for (const task of input.tasks) {
    for (const trial of task.trials) {
      const w = trial.weight
      num += trial.quality * w
      den += w
      if (trial.tokens === undefined) costUnknown = true
      else if (trial.tokens > 0) { costSum += trial.tokens; costCount += 1 }
    }
  }
  return {
    quality: den > 0 ? num / den : 0,
    cost: costCount > 0 ? costSum / costCount : undefined,
    expected: input.tasks.length * input.trials,
    missing: input.missing,
    incomplete: input.missing > 0 || costUnknown,
  }
}

/** 同一 (candidate, scope) 的全部重复求解合并，不取最新一次（plan §4）。
 *  scope 不一致即拒绝合并，不退化为按顺序取新。 */
export function poolEvaluations(evals: readonly EvaluationMeasurement[]): EvaluationMeasurement {
  if (evals.length === 0) throw new Error('poolEvaluations: no evaluations to pool')
  const scope = evals[0].scope
  const tasks: TaskMeasurement[] = []
  const byTask = new Map<string, TrialObservation[]>()
  let trials = 0
  let missing = 0
  for (const ev of evals) {
    if (ev.scope !== scope)
      throw new Error(`poolEvaluations: scope mismatch (${ev.scope} vs ${scope}); refusing to merge across frozen scopes`)
    trials += ev.trials
    missing += ev.missing
    for (const task of ev.tasks) {
      let slot = byTask.get(task.taskId)
      if (slot === undefined) {
        slot = []
        byTask.set(task.taskId, slot)
        tasks.push({ taskId: task.taskId, trials: slot })
      }
      slot.push(...task.trials)
    }
  }
  return { scope, trials, tasks, missing }
}

export interface NoiseCalibration {
  /** δ_quality：未改动方法两次独立评估的 |ΔŜ| 上限。 */
  qualityBand: number
  /** δ_cost：未改动方法相对成本的观测散布，用于带内「超过成本噪声」判据。 */
  relativeCostBand: number
  method: 'repeated-baseline-evaluations' | 'within-task-bootstrap' | 'declared-floor'
  evaluations: number
  standardError: number
  /** 无法观测到噪声：band 取 policy.noise.floor，调用方必须把它记进报告。 */
  degenerate: boolean
}

function meanOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function sampleStdev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const mean = meanOf(values)
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1))
}

function populationStdev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const mean = meanOf(values)
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length)
}

/** se(Ŝ) 的注入确定性重采样实现（对照上游 rrsi/calibrate.py:54 的 bootstrap_se）。
 *  重采样器是 32 位 LCG（state = state·1664525 + 1013904223 mod 2³²），取高位
 *  index = floor(state / 65536) % n（低位随奇偶翻转，不可用），无隐藏 RNG，
 *  TS 与提取脚本 extract-rrsi-vectors.py 逐位复算同一序列。 */
export function bootstrapStdError(ev: EvaluationMeasurement, reps: number, seed: number): number {
  const tasks = ev.tasks.filter((t) => t.trials.length > 0)
  let state = seed % 4294967296
  const values: number[] = []
  for (let rep = 0; rep < reps; rep += 1) {
    let num = 0
    let den = 0
    for (const task of tasks) {
      const n = task.trials.length
      for (let j = 0; j < n; j += 1) {
        state = (state * 1664525 + 1013904223) % 4294967296
        const trial = task.trials[Math.floor(state / 65536) % n]
        num += trial.quality * trial.weight
        den += trial.weight
      }
    }
    values.push(den > 0 ? num / den : 0)
  }
  return populationStdev(values)
}

/** δ = z · sd(null ΔS)。plan §4 override（对照 rrsi/calibrate.py:85）：
 *  - 直接观测要求 ≥ policy.noise.minIndependentEvaluations（默认 3）次独立求解，上游 ≥2；
 *  - 任何路径观测不到正散布时不得声称 δ = 0：degenerate + noise.floor（plan §4
 *    「单 trial 不产生零噪声结论」）。 */
export function calibrateNoise(evals: readonly EvaluationMeasurement[], policy: StrategyPolicy): NoiseCalibration {
  if (evals.length === 0) throw new Error('calibrateNoise: no base evaluations')
  const aggregates = evals.map(aggregateEvaluation)
  const z = policy.noise.z
  let observed: { band: number; method: 'repeated-baseline-evaluations' | 'within-task-bootstrap'; se: number } | undefined
  if (evals.length >= policy.noise.minIndependentEvaluations) {
    const scores = aggregates.map((a) => a.quality)
    const se = sampleStdev(scores)
    const sdNull = se * Math.SQRT2
    if (sdNull > 0) observed = { band: z * sdNull, method: 'repeated-baseline-evaluations', se }
  }
  if (observed === undefined) {
    const pooledEv = poolEvaluations(evals)
    const se = bootstrapStdError(pooledEv, policy.noise.bootstrapReps, policy.noise.seed)
    const sdBoot = Math.SQRT2 * se * Math.sqrt(pooledEv.trials / evals[0].trials)
    if (sdBoot > 0) observed = { band: z * sdBoot, method: 'within-task-bootstrap', se }
  }
  let degenerate = observed === undefined
  const qualityBand = observed?.band ?? policy.noise.floor
  const method = observed?.method ?? 'declared-floor'
  const standardError = observed?.se ?? 0
  const costs = aggregates.map((a) => a.cost).filter((c): c is number => c !== undefined && c > 0)
  let relativeCostBand: number
  if (costs.length >= 2) {
    const spread = z * sampleStdev(costs) / meanOf(costs)
    if (spread > 0) relativeCostBand = spread
    else { relativeCostBand = policy.noise.floor; degenerate = true }
  } else {
    relativeCostBand = policy.noise.floor
    degenerate = true
  }
  return { qualityBand, relativeCostBand, method, evaluations: evals.length, standardError, degenerate }
}
