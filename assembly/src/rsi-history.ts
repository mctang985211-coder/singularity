import type { Apparatus } from './apparatus.ts'
import { taskStateOf } from './apparatus.ts'
import { STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from '../../src/strategy/protocol.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { projectEvaluation } from '../../src/measure/view.ts'
import { pairedReport } from '../../src/measure/paired.ts'
import { sealedBytes } from './sealed.ts'
import { sha256 } from './ids.ts'
import type { RsiProposal } from './rsi-proposal.ts'
import { RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseDraft } from '../../src/release/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION } from '../../src/environment/protocol.ts'
import { methodEnvironment } from './method.ts'
import type { SolveResult } from './evolution.ts'

/** Submission already closes search admission. Its outcome is a view of committed results. */
export function searchView(apparatus: Apparatus, task: TaskState, cut = apparatus.store.load()) {
  if (task.search === undefined) return null
  const run = task.runs[task.search.runId]!
  if (run.status === 'running' && run.stage === 'working') return { ...task.search }
  let draft: ReleaseDraft | undefined, improved = false
  for (const fact of cut.entries()) {
    if (fact.subject !== methodEnvironment(apparatus)) continue
    if (fact.protocol === RELEASE_PROTOCOL && fact.version === RELEASE_VERSION && fact.kind === 'release/drafted')
      draft = fact.payload as ReleaseDraft
    const basis = draft?.basis
    if (fact.protocol === ENVIRONMENT_PROTOCOL && fact.version === ENVIRONMENT_VERSION && fact.kind === 'pointer/switched' &&
      basis?.kind === 'decision' && draft!.revisionId === (fact.payload as { to: string }).to &&
      (task.rounds?.some(round => round.roundId === basis.roundId && round.status === 'completed') ||
        task.transfer?.roundId === basis.roundId && task.transfer.outcome === 'improved')) improved = true
  }
  const rounds = cut.statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION)
  const evaluations = cut.statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
  const complete = (evaluation: EvaluationState | undefined): evaluation is EvaluationState => {
    if (evaluation === undefined) return false
    const view = projectEvaluation(evaluation)
    return view.denominator > 0 && view.missing.length === 0 && view.cost !== null &&
      view.constraints.every(constraint => constraint.met !== null) &&
      (evaluation.matrix === undefined || [...evaluation.observed, ...(evaluation.failed ?? [])].every(trial => trial.guardsMet !== undefined))
  }
  const insufficient = !task.rounds?.length || task.rounds.some(request => {
    const round = rounds.get(request.roundId), baseline = evaluations.get(`${request.roundId}:bootstrap:evaluation`)
    if (request.status !== 'completed' || round?.decision === undefined ||
      round.submissions.length !== request.candidates.length || !complete(baseline)) return true
    return round.submissions.some(submission => {
      const candidate = evaluations.get(submission.evaluationId)
      return !complete(candidate) || (baseline.matrix !== undefined && pairedReport(baseline, candidate).interval === null)
    })
  })
  const insufficientResult = task.transfer === undefined ? insufficient
    : task.transfer.outcome === undefined || task.transfer.outcome === 'insufficient-evidence'
  const outcome = improved ? 'improved' as const : insufficientResult
    ? 'insufficient-evidence' as const : 'no-improvement' as const
  return { ...task.search, outcome }
}

/** A bounded projection of committed search history; it never includes validation results. */
export function searchHistory(apparatus: Apparatus, task: TaskState) {
  const cut = apparatus.store.load()
  const rounds = [...cut.statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION).values()]
    .filter(r => r.plan?.campaignId === task.taskId).sort((a, b) => a.plan!.round - b.plan!.round)
  const evaluations = cut.statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
  const latest = rounds.at(-1)
  const source = task.runs[task.search!.runId]!.relatedTo!
  const incumbent = latest?.submissions.find(c => c.slot === latest.decision?.winner)?.revision
    ?? latest?.plan?.incumbent ?? taskStateOf(apparatus, source.taskId).runs[source.runId]!.revision
  return { incumbent, rounds, evaluations, directives: { historyCutoff: cut.entries().length,
    remainingSlots: task.search!.maxProposals - (task.search!.batches ?? []).reduce((n, b) => n + b.slots.length, 0),
    maxBatchSlots: 3, repairsPerSlot: 0 } }
}

export async function searchFeedback(apparatus: Apparatus, task: TaskState) {
  const { rounds, evaluations } = searchHistory(apparatus, task)
  const reviews = apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION)
  const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const workflow = (evaluation: EvaluationState) => [...evaluation.observed, ...(evaluation.failed ?? [])].map(observation => {
    const detail = observation.detail === undefined ? undefined : JSON.parse(observation.detail) as Partial<SolveResult>
    const seen = new Set<string>(), nodes: TaskState[] = []
    const visit = (id: string) => {
      const node = tasks.get(id)
      if (!node || seen.has(id)) return
      seen.add(id); nodes.push(node)
      for (const edge of node.decomposition?.children ?? []) visit(edge.taskId)
    }
    if (observation.run) visit(observation.run.taskId)
    const runs = nodes.flatMap(n => Object.values(n.runs))
    return { slot: observation.slot, caseId: evaluation.matrix?.slots[observation.slot]?.caseId ?? null,
      familyId: evaluation.matrix?.slots[observation.slot]?.familyId ?? null, source: observation.run ?? null,
      measurement: detail?.measurement === undefined ? null : {
        quality: detail.measurement.quality,
        metrics: Object.fromEntries(Object.entries(detail.measurement.metrics).slice(0, 32)),
        metricCount: Object.keys(detail.measurement.metrics).length,
        ...(detail.measurement.detail === undefined ? {} : { detail: detail.measurement.detail.slice(0, 2048) }),
      }, criteria: detail?.criteria ?? null,
      nodes: nodes.length, responsibilityEdges: nodes.reduce((n, node) => n + (node.decomposition?.children.length ?? 0), 0),
      dependencyEdges: nodes.flatMap(n => n.decomposition?.children ?? []).reduce((n, edge) => n + edge.dependsOn.length, 0),
      artifactInputs: nodes.flatMap(n => n.contract?.inputs ?? []).filter(i => i.source.kind === 'artifact').length,
      failedRuns: runs.filter(r => r.status === 'failed').length,
      consumption: (['bound', 'delivered', 'read', 'invoked'] as const).map(mode => ({ mode,
        count: runs.flatMap(r => r.consumed).filter(c => c.mode === mode).length })) }
  })
  const result = []
  for (const round of rounds.slice(-6)) for (const candidate of round.submissions) {
    const reviewId = `review-${sha256(`${apparatus.controlId}/proposal:${task.taskId}:${candidate.revision.digest}`).slice(0, 24)}`
    const review = reviews.get(reviewId)
    const proposal = review === undefined ? undefined : JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8')) as RsiProposal
    const baseline = evaluations.get(`${round.roundId}:bootstrap:evaluation`), observed = evaluations.get(candidate.evaluationId)
    const predicted = [...new Set([...(proposal?.edit.predicted_cases ?? []), ...apparatus.domain.suite?.cases
      .filter(c => c.split === 'evolve' && proposal?.edit.predicted_families?.includes(c.familyId)).map(c => c.caseId) ?? []])]
    result.push({ roundId: round.roundId, revision: candidate.revision, edits: candidate.edits,
      hypothesis: proposal?.edit.hypothesis ?? null, reviewId: review?.reviewId ?? null,
      outcome: round.decision === undefined ? 'pending' : round.decision.winner === candidate.slot ? 'accepted' : 'not-selected',
      baseline: baseline === undefined ? null : projectEvaluation(baseline),
      measured: observed === undefined ? null : projectEvaluation(observed),
      workflow: baseline && observed ? { baseline: workflow(baseline), candidate: workflow(observed),
        interpretation: 'organization and consumption observations; fewer nodes alone do not establish improvement or causality' } : null,
      attribution: baseline?.matrix && observed?.matrix ? pairedReport(baseline, observed, predicted) : null })
  }
  return { edits: result, rejected: task.search!.batches?.flatMap(b => b.outcomes.filter(o => o.status !== 'evaluation-requested')
    .map(o => ({ batchId: b.batchId, ...o }))).slice(-6) ?? [],
    interpretation: 'prediction hits are observed associations; unpredicted regressions remain visible and do not establish causality' }
}
