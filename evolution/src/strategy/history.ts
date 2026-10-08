// RRSI strategy port — derived from google-research/rrsi @ be50316 (Apache-2.0),
// rrsi/history.py. Divergences are marked "plan §4 override" at each site and
// pinned by correction tests.
import type { MechanismKind, StrategyPolicy } from './policy.ts'
import { MECHANISM_KINDS } from './policy.ts'
import { aggregateEvaluation, poolEvaluations } from './measure.ts'
import type { AggregateScore, EvaluationMeasurement } from './measure.ts'
import type { DeclaredEdit, ScreenRefusalCode } from './screen.ts'
import type { AdmissionReasonCode } from './selection.ts'

export interface CandidateFact {
  candidateId: string
  libraryId: string
  contentDigest: string
  round: number
  edits: readonly DeclaredEdit[]
  scope?: string
}
export interface EvaluationFact { candidateId: string; scope: string; measurement: EvaluationMeasurement; verdict: string; evidenceRefs: readonly string[] }
export interface ConsumptionFact { candidateId: string; consumedBy: readonly string[] }
export interface VersionFact { round: number; libraryId: string; revisionId: string; contentDigest: string }
export interface RefutationFact {
  candidateId: string; contentDigest: string; mechanism?: MechanismKind; hypothesis?: string
  reasonCode: AdmissionReasonCode | ScreenRefusalCode; reason: string
  evidenceRefs: readonly string[]; round: number
}
export interface HistoryFacts {
  candidates: readonly CandidateFact[]
  evaluations: readonly EvaluationFact[]
  consumption: readonly ConsumptionFact[]
  refutations: readonly RefutationFact[]
  versions: readonly VersionFact[]
}

export interface HistoryEntry {
  round: number; candidateId: string; mechanism?: MechanismKind; hypothesis?: string
  measured: boolean; deltaQuality?: number; deltaCost?: number
  outcome: 'accepted' | 'rejected' | 'lost' | 'unmeasured'; reasonCode?: string; evidenceRefs: readonly string[]
}
export interface MechanismYield { mechanism: MechanismKind; tried: boolean; recentBestGain?: number; acceptedEdits: number }
export interface SimplificationCandidate { kind: 'delete-candidate'; mechanism: MechanismKind; candidateIds: readonly string[]; recentBestGain?: number }
export interface HistoryView {
  scope: string
  bestQuality?: number
  entries: readonly HistoryEntry[]
  triedMechanisms: readonly MechanismKind[]
  untestedMechanisms: readonly MechanismKind[]
  yieldByMechanism: readonly MechanismYield[]
  /** 只给出「待删除候选」，绝不给出「按组件标签删功能」（plan §4 override：上游
   *  rrsi/history.py:152 的 prune_set 给出要删的组件）。没有候选 id 的机制不产生条目。 */
  simplificationCandidates: readonly SimplificationCandidate[]
  refutations: readonly RefutationFact[]
  roundsWithoutQualityGain: number
  steering: 'continue' | 'steer-untested' | 'stop-search'
}

const SCREEN_CODES: readonly string[] = ['over-budget', 'no-independent-mechanism', 'structure-failed', 'critic-missing', 'critic-reject']

/** 紧凑历史渲染时未测量 abort 的保留上限（照抄 rrsi/history.py:174 的 4）。 */
export const UNMEASURED_RENDER_LIMIT = 4

/** 历史由候选、评估、版本和消费事实派生（plan §4 override：上游 history.py:60 读自己写的
 *  JSONL）。同一 (candidateId, scope) 的全部重复评估经 poolEvaluations 聚合，绝不取最新一次。 */
export function foldHistory(facts: HistoryFacts, policy: StrategyPolicy, now: number): HistoryView {
  const candidateById = new Map(facts.candidates.map((c) => [c.candidateId, c]))
  const roundOf = (candidateId: string) => candidateById.get(candidateId)?.round ?? -1
  let scope = ''
  let scopeRound = -1
  for (const ev of facts.evaluations) {
    const r = roundOf(ev.candidateId)
    if (r > scopeRound || (r === scopeRound && ev.scope > scope)) {
      scope = ev.scope
      scopeRound = r
    }
  }
  const candidates = facts.candidates.filter((c) => c.scope === undefined || c.scope === scope)
  const latestVersion = facts.versions.reduce<VersionFact | undefined>(
    (best, v) => (best === undefined || v.round > best.round ? v : best), undefined)
  const pooled = new Map<string, EvaluationMeasurement[]>()
  for (const ev of facts.evaluations) {
    if (ev.scope !== scope) continue
    const list = pooled.get(ev.candidateId) ?? []
    list.push(ev.measurement)
    pooled.set(ev.candidateId, list)
  }
  const aggregateOf = (candidateId: string): AggregateScore | undefined => {
    const evals = pooled.get(candidateId)
    return evals === undefined ? undefined : aggregateEvaluation(poolEvaluations(evals))
  }
  const incumbent = latestVersion === undefined ? undefined
    : candidates.find((c) => c.contentDigest === latestVersion.contentDigest)
  const baseline = incumbent === undefined ? undefined : aggregateOf(incumbent.candidateId)

  const entries: HistoryEntry[] = []
  const measuredQualities: number[] = []
  for (const candidate of candidates) {
    const aggregate = aggregateOf(candidate.candidateId)
    const refutation = facts.refutations.find((r) => r.candidateId === candidate.candidateId)
    const evaluationRefs = facts.evaluations
      .filter((e) => e.candidateId === candidate.candidateId && e.scope === scope)
      .flatMap((e) => e.evidenceRefs)
    const measured = aggregate !== undefined || (refutation !== undefined && !SCREEN_CODES.includes(refutation.reasonCode))
    const accepted = facts.versions.some((v) => v.contentDigest === candidate.contentDigest)
    const outcome: HistoryEntry['outcome'] = accepted ? 'accepted'
      : !measured ? 'unmeasured'
      : refutation !== undefined ? 'rejected' : 'lost'
    const deltaQuality = aggregate !== undefined && baseline !== undefined ? aggregate.quality - baseline.quality : undefined
    const deltaCost = aggregate?.cost !== undefined && baseline?.cost !== undefined && baseline.cost > 0
      ? (aggregate.cost - baseline.cost) / baseline.cost : undefined
    const verified = candidate.edits.filter((e) => e.mechanismUnverified !== true)
    entries.push({
      round: candidate.round,
      candidateId: candidate.candidateId,
      mechanism: verified.length === 1 ? verified[0].mechanism : undefined,
      hypothesis: verified.length === 1 ? verified[0].hypothesis : undefined,
      measured,
      deltaQuality,
      deltaCost,
      outcome,
      reasonCode: refutation?.reasonCode,
      evidenceRefs: refutation?.evidenceRefs ?? evaluationRefs,
    })
    if (aggregate !== undefined) measuredQualities.push(aggregate.quality)
  }
  entries.sort((a, b) => a.round - b.round || (a.candidateId < b.candidateId ? -1 : 1))

  const mechanismsOf = (entry: HistoryEntry): MechanismKind[] => {
    const candidate = candidateById.get(entry.candidateId)
    return candidate === undefined ? [] : candidate.edits.filter((e) => e.mechanismUnverified !== true).map((e) => e.mechanism)
  }
  const tried = new Set<MechanismKind>()
  for (const entry of entries) if (entry.measured) for (const m of mechanismsOf(entry)) tried.add(m)

  const yieldByMechanism: MechanismYield[] = MECHANISM_KINDS.map((mechanism) => {
    const recent = entries.filter((e) => e.measured && e.deltaQuality !== undefined
      && now - e.round <= policy.pruneWindow && mechanismsOf(e).includes(mechanism))
    const gains = recent.map((e) => e.deltaQuality as number)
    return {
      mechanism,
      tried: tried.has(mechanism),
      recentBestGain: gains.length === 0 ? undefined : Math.max(...gains),
      acceptedEdits: entries.filter((e) => e.outcome === 'accepted' && mechanismsOf(e).includes(mechanism)).length,
    }
  })

  const simplificationCandidates: SimplificationCandidate[] = []
  for (const y of yieldByMechanism) {
    if (!y.tried || y.recentBestGain === undefined || y.recentBestGain > 0) continue
    const candidateIds = entries
      .filter((e) => e.outcome === 'accepted' && mechanismsOf(e).includes(y.mechanism))
      .map((e) => e.candidateId)
    if (candidateIds.length === 0) continue
    simplificationCandidates.push({ kind: 'delete-candidate', mechanism: y.mechanism, candidateIds, recentBestGain: y.recentBestGain })
  }

  const bestQuality = measuredQualities.length === 0 ? undefined : Math.max(...measuredQualities)

  let roundsWithoutQualityGain = 0
  for (let r = now - 1; r >= 0; r -= 1) {
    const gain = entries.some((e) => e.round === r && e.outcome === 'accepted'
      && e.deltaQuality !== undefined && e.deltaQuality > policy.noise.floor)
    if (gain) break
    roundsWithoutQualityGain += 1
  }

  const untestedMechanisms = MECHANISM_KINDS.filter((m) => !tried.has(m))
  const steering: HistoryView['steering'] = roundsWithoutQualityGain >= policy.stallRounds
    ? (untestedMechanisms.length > 0 ? 'steer-untested' : 'stop-search')
    : 'continue'

  return {
    scope, bestQuality, entries,
    triedMechanisms: MECHANISM_KINDS.filter((m) => tried.has(m)),
    untestedMechanisms,
    yieldByMechanism,
    simplificationCandidates,
    refutations: facts.refutations,
    roundsWithoutQualityGain,
    steering,
  }
}

/** 同字节候选直接结案（plan §4）：同 library 内已否证过的 contentDigest 立即拒绝，不再测量。
 *  调用方先把草稿登记为 CandidateFact 再调用；digest 未命中否证时退到同假设匹配。 */
export function refutationFor(facts: HistoryFacts, libraryId: string, contentDigest: string):
  { kind: 'same-bytes'; refutation: RefutationFact } | { kind: 'same-hypothesis'; refutation: RefutationFact } | undefined {
  const libraryOf = (candidateId: string) => facts.candidates.find((c) => c.candidateId === candidateId)?.libraryId
  const sameBytes = facts.refutations.find((r) => r.contentDigest === contentDigest && libraryOf(r.candidateId) === libraryId)
  if (sameBytes !== undefined) return { kind: 'same-bytes', refutation: sameBytes }
  const draft = facts.candidates.find((c) => c.libraryId === libraryId && c.contentDigest === contentDigest)
  const hypotheses = (draft?.edits ?? []).map((e) => e.hypothesis).filter((h): h is string => h !== undefined)
  if (hypotheses.length > 0) {
    const sameHypothesis = facts.refutations.find((r) => r.hypothesis !== undefined
      && hypotheses.includes(r.hypothesis) && libraryOf(r.candidateId) === libraryId)
    if (sameHypothesis !== undefined) return { kind: 'same-hypothesis', refutation: sameHypothesis }
  }
  return undefined
}

/** 已否证假设需要新证据才能重测（plan §4）。scope 变化也算新情境。 */
export function mayRetest(facts: HistoryFacts, refutation: RefutationFact, input: {
  scope: string; evidenceRefs: readonly string[]
}): boolean {
  if (input.evidenceRefs.some((ref) => !refutation.evidenceRefs.includes(ref))) return true
  const candidate = facts.candidates.find((c) => c.candidateId === refutation.candidateId)
  return candidate?.scope !== undefined && candidate.scope !== input.scope
}

/** σ_t = 1[S_t − S_{t−w} ≤ δ]，w 轮以内历史不足时为 0（照抄 rrsi/history.py:189）。 */
export function stallFlag(trajectory: readonly number[], t: number, window: number, band: number): 0 | 1 {
  if (t < window || t >= trajectory.length || t - window < 0) return 0
  return trajectory[t] - trajectory[t - window] <= band ? 1 : 0
}

/** E_t = (σ_t, U_t, m_draft) 加交给 proposer 的文本（对照 rrsi/history.py:196，
 *  机制词表换成本移植的 MECHANISM_KINDS）。 */
export function exploration(t: number, stall: 0 | 1, tried: readonly MechanismKind[], reservedDrafts: number): {
  sigma: 0 | 1; untried: readonly MechanismKind[]; reservedDrafts: number; text: string
} {
  void t
  const untried = MECHANISM_KINDS.filter((m) => !tried.includes(m))
  let text: string
  if (stall === 1 && untried.length > 0) {
    text = `STALL: the incumbent has not moved by more than the noise band over the last rounds (sigma_t = 1). ${reservedDrafts} candidate slot(s) this round are RESERVED for exploratory edits on mechanisms the run has never exercised: ${untried.join(', ')}. A variant holding a reserved slot must put at least one edit on one of those mechanisms.`
  } else if (untried.length > 0) {
    text = `Mechanisms not yet exercised in this run: ${untried.join(', ')}. Not mandatory this round (sigma_t = 0), but evidence about them is still missing.`
  } else {
    text = 'Every mechanism in K has been exercised at least once.'
  }
  return { sigma: stall, untried, reservedDrafts, text }
}

/** 紧凑历史：measured 主导，未测量 abort 最多保留 UNMEASURED_RENDER_LIMIT 条
 *  （照抄 rrsi/history.py:166-185）。 */
export function renderHistory(view: HistoryView, limit: number): readonly HistoryEntry[] {
  const kept: HistoryEntry[] = []
  let unmeasured = 0
  for (const entry of [...view.entries].reverse()) {
    if (!entry.measured) {
      unmeasured += 1
      if (unmeasured > UNMEASURED_RENDER_LIMIT) continue
    }
    kept.push(entry)
    if (kept.length >= limit) break
  }
  return kept.reverse()
}
