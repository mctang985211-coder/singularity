import type { EvaluationState } from './protocol.ts'
import { digestOf } from '../protocol/envelope.ts'

export interface PairedReport {
  readonly status: 'improved' | 'no-improvement' | 'insufficient-evidence'
  readonly reason: string
  readonly families: readonly { readonly familyId: string; readonly delta: number; readonly cases: number }[]
  readonly interval: readonly [number, number] | null
  readonly costInterval: readonly [number, number] | null
  readonly costCoverage: number
  readonly regressions: readonly string[]
  readonly predictions: { readonly hit: readonly string[]; readonly missed: readonly string[]; readonly unexpected: readonly string[] }
}

/** Frozen paired cases, grouped before uncertainty is computed. A case's repeated seeds are not new families. */
export function pairedReport(baseline: EvaluationState, candidate: EvaluationState, predicted: readonly string[] = []): PairedReport {
  const families: { familyId: string; delta: number; cases: number }[] = [], regressions: string[] = []
  const empty = (reason: string): PairedReport => ({ status: 'insufficient-evidence', reason, families, interval: null, costInterval: null, costCoverage: 0, regressions,
    predictions: { hit: [], missed: [...predicted], unexpected: [] } })
  if (baseline.matrix === undefined || candidate.matrix === undefined || digestOf(baseline.matrix) !== digestOf(candidate.matrix) ||
    digestOf(baseline.metric ?? null) !== digestOf(candidate.metric ?? null)) return empty('unpaired suite, metric or execution profile')
  const a = [...baseline.observed, ...(baseline.failed ?? [])], b = [...candidate.observed, ...(candidate.failed ?? [])], slots = baseline.matrix.slots
  if (a.length !== slots.length || b.length !== slots.length || baseline.missed.length || candidate.missed.length) return empty('planned observations are missing')
  const sign = baseline.metric?.direction === 'lower' ? -1 : 1
  const cases = [...new Set(slots.map(s => s.caseId))].map(caseId => {
    const indexes = slots.flatMap((s, i) => s.caseId === caseId ? [i] : [])
    const delta = indexes.reduce((sum, i) => sum + sign * (b.find(t => t.slot === i)!.quality - a.find(t => t.slot === i)!.quality), 0) / indexes.length
    if (delta < 0) regressions.push(caseId)
    return { caseId, familyId: slots[indexes[0]!]!.familyId, delta, trials: indexes.length, weight: indexes.reduce((sum, i) => sum + slots[i]!.weight, 0) }
  })
  for (const familyId of [...new Set(cases.map(c => c.familyId))].sort()) {
    const held = cases.filter(c => c.familyId === familyId), weight = held.reduce((sum, c) => sum + c.weight, 0)
    families.push({ familyId, cases: held.length, delta: held.reduce((sum, c) => sum + c.delta * c.weight, 0) / weight })
  }
  const affected = cases.filter(c => c.delta !== 0).map(c => c.caseId)
  const predictions = { hit: predicted.filter(id => affected.includes(id)), missed: predicted.filter(id => !affected.includes(id)), unexpected: regressions.filter(id => !predicted.includes(id)) }
  const costCoverage = [...a, ...b].filter(t => t.cost !== undefined).length / (2 * slots.length)
  if (families.length < 3 || cases.some(c => c.trials < 2)) return { ...empty('at least three independent families and two trials per case are required'), costCoverage, predictions }
  const mean = families.reduce((sum, f) => sum + f.delta, 0) / families.length
  const variance = families.reduce((sum, f) => sum + (f.delta - mean) ** 2, 0) / (families.length - 1)
  // Conservative two-sided 95% t bound, rounded upward by degrees-of-freedom buckets.
  const df = families.length - 1, t = df < 3 ? 4.303 : df < 5 ? 3.183 : df < 10 ? 2.776 : df < 20 ? 2.263 : df < 30 ? 2.094 : 2.045
  const radius = t * Math.sqrt(variance / families.length), interval = [mean - radius, mean + radius] as const
  const familyCosts = families.map(f => {
    const indexes = slots.flatMap((s, i) => s.familyId === f.familyId ? [i] : [])
    const sum = (xs: typeof a) => indexes.reduce((n, i) => n + (xs.find(x => x.slot === i)!.cost ?? 0), 0)
    const base = sum(a)
    return (sum(b) - base) / Math.max(1, base)
  })
  const costMean = familyCosts.reduce((s, n) => s + n, 0) / familyCosts.length
  const costVariance = familyCosts.reduce((s, n) => s + (n - costMean) ** 2, 0) / (familyCosts.length - 1)
  const costRadius = t * Math.sqrt(costVariance / familyCosts.length)
  const costInterval = costCoverage === 1 ? [costMean - costRadius, costMean + costRadius] as const : null
  const guards = b.every(t => t.guardsMet === true)
  const totalCost = (xs: typeof a) => xs.reduce((sum, x) => sum + (x.cost ?? 0), 0)
  const costAllowed = costCoverage === 1 && totalCost(b) <= totalCost(a) * 1.25
  const improved = guards && costAllowed && interval[0] >= 0 && (mean > 0 || costInterval !== null && costMean < 0 && costInterval[1] <= 0)
  return { status: improved ? 'improved' : guards && costCoverage === 1 ? 'no-improvement' : 'insufficient-evidence',
    reason: improved ? 'paired family quality gain or cost reduction with nonnegative quality interval, hard guards and cost ceiling' : !guards ? 'hard guard evidence failed' : !costAllowed ? 'cost coverage or ceiling failed' : 'paired gain is not established',
    families, interval, costInterval, costCoverage, regressions, predictions }
}
