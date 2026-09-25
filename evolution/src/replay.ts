/**
 * Replay report schema and candidate-vs-champion comparison (guide §2.7.6,
 * W15). A replay is a comparison experiment: the champion side is the
 * historical task's own terminal record (never re-executed), the candidate
 * side is the fresh replay run's outcome. The report lands at
 * `<ledger root>/sandbox/<proposalId>/replay-report.json` and the ledger's
 * `replayed` record cites it by that root-relative path.
 *
 * The comparison is mechanical, never a judgement: outcome ranks
 * (verified > failed), a shared criterion flipping pass → anything else is a
 * regression, and a candidate run that could not settle (cancelled) is
 * inconclusive, not worse. "Not worse" is the strongest claim this schema
 * makes; whether that suffices for promotion is the human gate's call.
 * @module dsh-singularity-evolution
 */

import type { ProposalTargetType } from '@dangosys/dsh-singularity-task'

/** Overall replay verdict: whether the candidate is not worse than the champion. */
export type ReplayVerdict = 'not-worse' | 'worse' | 'inconclusive' | 'manual'
/** Per-task comparison outcome; `manual` marks the agent_preset v1 boundary (nothing executed). */
export type ReplayRelation = 'not-worse' | 'worse' | 'inconclusive' | 'manual'

export const REPLAY_VERDICTS: readonly ReplayVerdict[] = ['not-worse', 'worse', 'inconclusive', 'manual']
export const REPLAY_RELATIONS: readonly ReplayRelation[] = ['not-worse', 'worse', 'inconclusive', 'manual']

/** One criterion's verdict on one side, as the record / fresh run reported it. */
export interface ReplayCriterionSummary {
  criterionId: string
  verdict: 'pass' | 'fail' | 'inconclusive'
  command?: string
  exitCode?: number
}

/**
 * The content identity of a single-file skill candidate (P2): the skill name
 * plus the SHA-256 of the exact bytes of the materialized `SKILL.md`. Recorded
 * at prepare, carried by the replay report, and re-verified before the
 * `replayed` record is written, at every promotion gate, and on the apply
 * write — so the chain can never validate one file's content and apply
 * another's. Only `targetType: skill` candidates carry one.
 */
export interface SkillContentIdentity {
  /** The skill name the mutation targets (`mutation.name`, the proposal's targetId). */
  name: string
  /** Lowercase SHA-256 hex over the exact file bytes — no trim, no newline conversion. */
  sha256: string
}

/** One side of one task's comparison. The champion is the historical record; the candidate is the fresh replay run. */
export interface ReplaySideSummary {
  taskId: string
  runId?: string
  outcome: 'verified' | 'failed' | 'cancelled'
  durationMs?: number
  criteria: ReplayCriterionSummary[]
}

/** One criterion whose verdict differs between the sides (absent side = the criterion exists only on the other). */
export interface ReplayCriterionDiff {
  criterionId: string
  champion?: string
  candidate?: string
}

export interface ReplayTaskComparison {
  /** The champion (historical) task id. */
  taskId: string
  /** The replay task created for the candidate run. */
  candidateTaskId?: string
  champion: ReplaySideSummary
  candidate?: ReplaySideSummary
  /** True when outcome and every shared criterion verdict agree and no criterion moved between the sides. */
  verdictMatch: boolean
  /** Criterion-level differences (both verdict flips and added/removed criteria). */
  criteriaDiff: ReplayCriterionDiff[]
  relation: ReplayRelation
}

export interface ReplayReport {
  formatVersion: 1
  proposalId: string
  targetType: ProposalTargetType
  at: string
  /** `executed`: candidate runs really ran. `manual`: nothing executed (agent_preset v1) and `manualReason` says why. */
  mode: 'executed' | 'manual'
  manualReason?: string
  /**
   * Skill candidates only (P2): the candidate content identity this replay ran
   * against — it must equal the `prepared` record's `skillContent`. Other
   * targetTypes carry no skill fields.
   */
  candidateContent?: SkillContentIdentity
  /** Comparisons over `taskIds` (the tasks the proposal's evidence already covers). */
  observed: ReplayTaskComparison[]
  /** Comparisons over `holdoutTaskIds`; `executed: false` + empty tasks reads as "not run". */
  holdout: { executed: boolean; tasks: ReplayTaskComparison[] }
  verdict: ReplayVerdict
}

/** verified outranks failed; anything else (cancelled) has no rank and reads inconclusive. */
const OUTCOME_RANK: Readonly<Record<string, number>> = { verified: 1, failed: 0 }

/**
 * Compare one task's two sides. A regression is mechanical: the candidate's
 * outcome ranks below the champion's, or a criterion both sides report flipped
 * from pass to anything else. An unrankable candidate outcome (cancelled) is
 * inconclusive — it says nothing about the candidate's quality.
 */
export function compareReplaySides(
  champion: ReplaySideSummary,
  candidate: ReplaySideSummary,
): Pick<ReplayTaskComparison, 'verdictMatch' | 'criteriaDiff' | 'relation'> {
  const championCriteria = new Map(champion.criteria.map(item => [item.criterionId, item.verdict]))
  const candidateCriteria = new Map(candidate.criteria.map(item => [item.criterionId, item.verdict]))
  const criteriaDiff: ReplayCriterionDiff[] = []
  for (const criterionId of new Set([...championCriteria.keys(), ...candidateCriteria.keys()])) {
    const before = championCriteria.get(criterionId)
    const after = candidateCriteria.get(criterionId)
    if (before !== after) {
      criteriaDiff.push({
        criterionId,
        ...(before === undefined ? {} : { champion: before }),
        ...(after === undefined ? {} : { candidate: after }),
      })
    }
  }
  const verdictMatch = champion.outcome === candidate.outcome && criteriaDiff.length === 0
  const championRank = OUTCOME_RANK[champion.outcome]
  const candidateRank = OUTCOME_RANK[candidate.outcome]
  if (candidateRank === undefined || championRank === undefined) {
    return { verdictMatch, criteriaDiff, relation: 'inconclusive' }
  }
  const regressedCriterion = criteriaDiff.some(diff => diff.champion === 'pass')
  const changedContract = criteriaDiff.some(diff => diff.champion === undefined || diff.candidate === undefined)
    || champion.criteria.some(before => candidate.criteria.find(after => after.criterionId === before.criterionId)?.command !== before.command)
  const relation: ReplayRelation = candidateRank < championRank || regressedCriterion
    ? 'worse'
    : changedContract ? 'inconclusive' : 'not-worse'
  return { verdictMatch, criteriaDiff, relation }
}

/** The overall verdict over one group of comparisons: any regression wins; absent that, any inconclusive holds it back. */
export function overallReplayVerdict(comparisons: readonly Pick<ReplayTaskComparison, 'relation'>[]): ReplayVerdict {
  if (comparisons.some(item => item.relation === 'worse')) return 'worse'
  if (comparisons.length === 0 || comparisons.some(item => item.relation === 'inconclusive')) return 'inconclusive'
  if (comparisons.every(item => item.relation === 'manual')) return 'manual'
  if (comparisons.some(item => item.relation === 'manual')) return 'inconclusive'
  return 'not-worse'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertSide(value: unknown, field: string): asserts value is ReplaySideSummary {
  if (!isRecord(value) || typeof value.taskId !== 'string' || value.taskId.length === 0
    || !['verified', 'failed', 'cancelled'].includes(value.outcome as string)
    || !Array.isArray(value.criteria)) {
    throw new Error(`evolution: replay report ${field} must carry a taskId, a valid outcome and criteria`)
  }
  const ids = new Set<string>()
  for (const criterion of value.criteria) {
    if (!isRecord(criterion) || typeof criterion.criterionId !== 'string' || criterion.criterionId.length === 0
      || ids.has(criterion.criterionId) || !['pass', 'fail', 'inconclusive'].includes(criterion.verdict as string)
      || (criterion.command !== undefined && typeof criterion.command !== 'string')) {
      throw new Error(`evolution: replay report ${field} has an invalid or duplicate criterion`)
    }
    ids.add(criterion.criterionId)
  }
  if (value.outcome === 'verified' && ids.size === 0) {
    throw new Error(`evolution: replay report ${field} verified outcome needs criterion evidence`)
  }
}

function assertComparison(value: unknown, field: string, mode: 'executed' | 'manual'): asserts value is ReplayTaskComparison {
  if (!isRecord(value)) throw new Error(`evolution: replay report ${field} must be an object`)
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) {
    throw new Error(`evolution: replay report ${field}.taskId must be a non-empty string`)
  }
  if (!isRecord(value.champion) || typeof value.champion.outcome !== 'string') {
    throw new Error(`evolution: replay report ${field}.champion must carry an outcome`)
  }
  if (typeof value.relation !== 'string' || !REPLAY_RELATIONS.includes(value.relation as ReplayRelation)) {
    throw new Error(`evolution: replay report ${field}.relation must be one of ${REPLAY_RELATIONS.join(' / ')}`)
  }
  assertSide(value.champion, `${field}.champion`)
  if (value.taskId !== value.champion.taskId) throw new Error(`evolution: replay report ${field} champion identity mismatch`)
  if (mode === 'manual') {
    if (value.relation !== 'manual' || value.candidate !== undefined) {
      throw new Error(`evolution: replay report ${field} manual comparison cannot claim an executed candidate`)
    }
    return
  }
  assertSide(value.candidate, `${field}.candidate`)
  if (value.candidateTaskId !== value.candidate.taskId || value.candidate.taskId === value.taskId) {
    throw new Error(`evolution: replay report ${field} candidate identity mismatch`)
  }
  const computed = compareReplaySides(value.champion, value.candidate)
  if (value.relation !== computed.relation || value.verdictMatch !== computed.verdictMatch
    || JSON.stringify(value.criteriaDiff) !== JSON.stringify(computed.criteriaDiff)) {
    throw new Error(`evolution: replay report ${field} comparison does not match its evidence`)
  }
}

/**
 * Validate a report against the proposal it claims to serve. The v1 manual
 * boundary is enforced here: only an agent_preset replay may record
 * `mode: 'manual'` (the preset roster scans constructor-fixed roots and cannot
 * mount a sandbox-materialized preset), and only a manual report may carry the
 * `manual` verdict — every other targetType must produce executed evidence.
 * A skill report must additionally carry the candidate content identity
 * (`candidateContent`) the replay ran against; equality with the prepared
 * record is the service's check, not this schema's.
 */
export function assertReplayReport(
  proposal: { proposalId: string; targetType: ProposalTargetType },
  report: unknown,
): asserts report is ReplayReport {
  if (!isRecord(report)) throw new Error('evolution: replay report must be an object')
  if (report.formatVersion !== 1) throw new Error('evolution: replay report formatVersion must be 1')
  if (report.proposalId !== proposal.proposalId) {
    throw new Error(`evolution: replay report proposalId "${String(report.proposalId)}" does not match "${proposal.proposalId}"`)
  }
  if (report.targetType !== proposal.targetType) {
    throw new Error(`evolution: replay report targetType "${String(report.targetType)}" does not match "${proposal.targetType}"`)
  }
  if (typeof report.at !== 'string' || report.at.length === 0) throw new Error('evolution: replay report.at must be a non-empty string')
  if (report.mode !== 'executed' && report.mode !== 'manual') {
    throw new Error('evolution: replay report mode must be "executed" or "manual"')
  }
  if (report.mode === 'manual') {
    if (proposal.targetType !== 'agent_preset') {
      throw new Error(`evolution: a manual replay report is only valid for agent_preset proposals, not "${proposal.targetType}"`)
    }
    if (typeof report.manualReason !== 'string' || report.manualReason.length === 0) {
      throw new Error('evolution: a manual replay report requires a manualReason')
    }
  }
  if (typeof report.verdict !== 'string' || !REPLAY_VERDICTS.includes(report.verdict as ReplayVerdict)) {
    throw new Error(`evolution: replay report verdict must be one of ${REPLAY_VERDICTS.join(' / ')}`)
  }
  if (report.mode === 'manual' && report.verdict !== 'manual') {
    throw new Error('evolution: a manual replay report must carry verdict "manual"')
  }
  if (report.mode === 'executed' && report.verdict === 'manual') {
    throw new Error('evolution: an executed replay report cannot carry verdict "manual"')
  }
  if (!Array.isArray(report.observed)) throw new Error('evolution: replay report.observed must be an array')
  report.observed.forEach((item, index) => assertComparison(item, `observed[${index}]`, report.mode as 'executed' | 'manual'))
  if (!isRecord(report.holdout) || typeof report.holdout.executed !== 'boolean' || !Array.isArray(report.holdout.tasks)) {
    throw new Error('evolution: replay report.holdout must be { executed: boolean, tasks: [] }')
  }
  report.holdout.tasks.forEach((item, index) => assertComparison(item, `holdout.tasks[${index}]`, report.mode as 'executed' | 'manual'))
  if (report.holdout.executed !== (report.holdout.tasks.length > 0)) {
    throw new Error('evolution: replay report.holdout.executed must agree with its task list (empty = not run)')
  }
  if (report.mode === 'executed' && report.observed.length === 0) {
    throw new Error('evolution: an executed replay report needs at least one observed task comparison')
  }
  const comparisons = [...report.observed, ...report.holdout.tasks] as ReplayTaskComparison[]
  const taskIds = comparisons.map(item => item.taskId)
  const candidateIds = comparisons.flatMap(item => item.candidate === undefined ? [] : [item.candidate.taskId])
  if (new Set(taskIds).size !== taskIds.length || new Set(candidateIds).size !== candidateIds.length
    || candidateIds.some(id => taskIds.includes(id))) {
    throw new Error('evolution: replay report observed and holdout must use distinct champion and candidate tasks')
  }
  if (report.mode === 'executed' && report.verdict !== overallReplayVerdict(comparisons)) {
    throw new Error('evolution: replay report verdict does not match its comparisons')
  }
  // P2 content binding: a skill report must name the candidate content
  // identity it ran against (the service then checks it against the prepared
  // record and the live file). Last, so the schema checks above keep their
  // specific diagnostics.
  if (proposal.targetType === 'skill') {
    const identity = report.candidateContent
    if (!isRecord(identity) || typeof identity.name !== 'string' || identity.name.length === 0
      || typeof identity.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(identity.sha256)) {
      throw new Error(
        'evolution: a skill replay report must carry candidateContent { name, sha256 } bound at prepare — ' +
        'evidence without the candidate content identity predates content binding; propose a new candidate and re-evaluate it',
      )
    }
  }
}

/** A human approval cannot substitute for two independent, non-regressing replay groups. */
export function assertReplayPromotable(report: ReplayReport): void {
  if (report.mode !== 'executed') throw new Error('evolution: promotion requires executed replay evidence, not a manual report')
  for (const [name, tasks] of [['observed', report.observed], ['holdout', report.holdout.tasks]] as const) {
    if (overallReplayVerdict(tasks) !== 'not-worse') {
      throw new Error(`evolution: promotion requires non-empty ${name} replay with no regressions or inconclusive results`)
    }
  }
}
