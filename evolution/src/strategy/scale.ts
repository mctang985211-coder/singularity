// RRSI strategy port — derived from google-research/rrsi @ be50316 (Apache-2.0),
// rrsi/evaluate.py (Eq. estimate: r in [0,1]). Divergences are marked
// "plan §4 override" at each site and pinned by correction tests.

/** 冻结的 [0,1] 质量标尺（plan §4）。领域 command / judge 提供数值时必须提前固定标尺。 */
export type QualityScale =
  | { kind: 'acceptance-success-rate' }
  | {
      kind: 'fixed-numeric-scale'
      /** 冻结的 measurement id，必须在本次实验的 measurement 列表内。 */
      metricId: string
      atLeast: number
      atMost: number
      direction: 'higher-is-better' | 'lower-is-better'
    }

/** 一次 trial 的原始观测。acceptance 由原验收决定，永远不是 LLM 给的。 */
export interface QualitySample {
  acceptance: 'pass' | 'fail' | 'inconclusive'
  /** 领域 command / judge 的数值，缺席即该 trial 未测。 */
  readonly numeric?: number
  /** 本 trial 上报的四桶 token 总额；缺席即成本未知。 */
  readonly tokens?: number
  /** trial 内冻结判据权重，默认 1。 */
  readonly weight?: number
}

/** trial → [0,1] 质量。原验收不可被数值补偿（plan §4）。
 *
 *  判定顺序不可交换：fail → 0（即使 numeric 满分）；inconclusive → 0 且调用方必须记为
 *  missing（分母不缩小）；pass 才允许标尺数值进入。LLM judge 的分数只能经预先冻结的
 *  fixed-numeric-scale 进入，且仍以原验收为前置条件。 */
export function qualityOf(scale: QualityScale, sample: QualitySample): number {
  let quality: number
  if (sample.acceptance === 'fail' || sample.acceptance === 'inconclusive') {
    quality = 0
  } else if (scale.kind === 'acceptance-success-rate') {
    quality = 1
  } else {
    if (!(scale.atMost > scale.atLeast))
      throw new Error(`QualityScale ${scale.metricId}: expected atMost > atLeast, got [${scale.atLeast}, ${scale.atMost}]`)
    if (sample.numeric === undefined) {
      quality = 0
    } else {
      if (!Number.isFinite(sample.numeric))
        throw new Error(`QualitySample.numeric: expected a finite number, got ${sample.numeric}`)
      const t = (sample.numeric - scale.atLeast) / (scale.atMost - scale.atLeast)
      quality = Math.min(1, Math.max(0, scale.direction === 'lower-is-better' ? 1 - t : t))
    }
  }
  if (!Number.isFinite(quality) || quality < 0 || quality > 1)
    throw new Error(`qualityOf: result ${quality} escapes [0,1]`)
  return quality
}

/** 标尺必须指向本次实验已冻结的 measurement / 判据；否则拒绝，避免事后挑标尺。 */
export function assertScaleAddressesFrozenMeasurement(
  scale: QualityScale,
  frozen: { readonly measurements: readonly { id: string }[] },
): void {
  if (scale.kind === 'acceptance-success-rate') return
  if (!frozen.measurements.some((m) => m.id === scale.metricId))
    throw new Error(`QualityScale ${scale.metricId}: not a frozen measurement of this experiment`)
}
