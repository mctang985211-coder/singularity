import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import { budgetList, CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, utf8Bytes } from '@dangosys/dsh-singularity-context'
import type { Diagnosis, ReviewDimensions, ReviewMetrics, ReviewRecord, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { JUDGED_DIMENSIONS, rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { readReviewAgentAttempts } from '../coordination/ledger.ts'
import type { ReviewAgentAttempt, ReviewAgentSource } from '../coordination/ledger.ts'
import { handoffFactsOf, handoffStateLine, needsSupervisor, roundsForDiagnosis } from '../coordination/handoff-rules.ts'
import type { HandoffFacts } from '../coordination/handoff-rules.ts'
import { reviewRef } from '../coordination/identity.ts'
import { sessionId, text } from '../shared.ts'

export { reviewRef }

/** The judgement line: the six dimensions whose conclusion the fact table does not carry, named so a reader cannot mistake the facts for a verdict. */
export function renderJudgementDimensions(): string {
  return `needs judgement (agent): ${JUDGED_DIMENSIONS.join(', ')} (not mechanically observable from the fact table; a review agent may conclude them)`
}

/** The review record of one exact source, or nothing when the store holds none. */
export function reviewForSource(snapshot: TaskSnapshot, source: ReviewAgentSource): ReviewRecord | undefined {
  return snapshot.reviews.find(review => review.taskId === source.taskId && (review.runId ?? null) === source.runId)
}

/** The ledger state of one source: every **review** attempt the store holds for it, in the order they were claimed — the default attempt (`null` key) and each explicit one — with how each ended. */
function renderAttempts(attempts: readonly ReviewAgentAttempt[], source: ReviewAgentSource): string[] {
  const mine = attempts.filter(attempt => attempt.role === 'reviewer' && attempt.source.taskId === source.taskId && attempt.source.runId === source.runId)
  if (mine.length === 0) {
    return ['review attempts (0): none — no review agent has been started for this source']
  }
  return [`review attempts (${mine.length}):`, ...mine.map(attempt => {
    const label = attempt.requestKey === null ? 'default attempt' : `requestKey "${attempt.requestKey}"`
    const status = attempt.settlement?.status ?? 'in-flight'
    const note = attempt.settlement?.note === undefined ? '' : ` — ${attempt.settlement.note}`
    const reason = attempt.reason === null ? '' : ` reason ${JSON.stringify(attempt.reason)}`
    return `- ${label} ${attempt.sessionId} [${status}]${reason}${note}`
  })]
}

/** The effort line: one clause per counter that exists, and nothing for the ones that do not — an absent field means "not observed" (see `ReviewMetrics`), so printing 0 for it would invent a measurement. */
function renderMetrics(metrics: ReviewMetrics): string {
  const parts: string[] = []
  if (metrics.tokens !== undefined) {
    parts.push(`tokens in ${metrics.tokens.uncachedInputTokens}/out ${metrics.tokens.outputTokens}/cache ${metrics.tokens.cacheReadTokens}+${metrics.tokens.cacheWriteTokens} (session-cumulative)`)
  }
  if (metrics.toolCalls !== undefined) parts.push(`toolCalls ${metrics.toolCalls.calls} (${metrics.toolCalls.failures} failed)`)
  if (metrics.humanInterventions !== undefined) parts.push(`humanInterventions ${metrics.humanInterventions} (session-scoped)`)
  if (metrics.retries !== undefined) parts.push(`retries ${metrics.retries} (runs beyond the first; a recovery attempt is one)`)
  if (metrics.evidenceLogs !== undefined) parts.push(`evidenceLogs ${metrics.evidenceLogs}`)
  return parts.join(' — ')
}

/** One line per dimension that the record actually carries: the observed facts, copied out, never rated and never narrated. */
function renderDimensions(dimensions: ReviewDimensions): string[] {
  const lines: string[] = []
  const outcome = dimensions.outcomeCorrectness
  if (outcome !== undefined) {
    lines.push(`  dim outcome correctness: ${outcome.outcome}, criteria ${outcome.criteriaCount}, unmet [${outcome.unmetCriterionIds.join(', ')}]`)
  }
  const specification = dimensions.taskSpecification
  if (specification !== undefined) {
    lines.push(`  dim task specification: objective ${specification.objectivePresent ? 'present' : 'empty'}, criteria ${specification.criteriaCount}, with command ${specification.criteriaWithCommand}`)
  }
  const acceptance = dimensions.acceptance
  if (acceptance !== undefined) {
    const criteria = acceptance.criteria
      .map(item => `${item.criterionId} ${item.mode}${item.hasCommand ? ' +command' : ''}${item.mandatory ? '' : ' optional'}`)
    lines.push(`  dim acceptance: ${criteria.join('; ')}`)
  }
  const decomposition = dimensions.decomposition
  if (decomposition !== undefined) {
    lines.push(`  dim decomposition: depth ${decomposition.depth}, ${decomposition.decompositionStatus}, children ${decomposition.childCount}, edges in/out ${decomposition.incomingEdges}/${decomposition.outgoingEdges}`)
  }
  const coverage = dimensions.capabilityCoverage
  if (coverage !== undefined) {
    lines.push(`  dim capability coverage: ${coverage.closure}, granted [${coverage.granted.join(', ')}], missing [${coverage.missing.join(', ')}]`)
  }
  const skill = dimensions.skillFit
  if (skill !== undefined) {
    const loaded = (skill.loaded === undefined ? '' : `, loaded [${skill.loaded.join(', ')}]`) +
      (skill.loadedOutsideGrant === undefined ? '' : `, outside grant [${skill.loadedOutsideGrant.join(', ')}]`)
    lines.push(`  dim skill fit: granted [${skill.granted.join(', ')}]${loaded}`)
  }
  const tools = dimensions.toolFit
  if (tools !== undefined) {
    const called = (tools.called === undefined ? '' : `, called [${tools.called.map(item => `${item.name} x${item.count}`).join(', ')}]`) +
      (tools.calledOutsideGrant === undefined ? '' : `, outside grant [${tools.calledOutsideGrant.join(', ')}]`)
    lines.push(`  dim tool fit: granted [${tools.granted.join(', ')}]${called}`)
  }
  const context = dimensions.contextEfficiency
  if (context !== undefined) {
    const tokens = context.tokens === undefined
      ? ''
      : ` tokens in/out ${context.tokens.uncachedInputTokens}/${context.tokens.outputTokens}`
    const compactions = context.compactions === undefined ? '' : ` compactions ${context.compactions}`
    const cache = context.tokens === undefined ? '' : ` cache read/write ${context.tokens.cacheReadTokens}/${context.tokens.cacheWriteTokens}`
    lines.push(`  dim context efficiency:${tokens}${compactions}${cache}`)
  }
  return lines
}

/** One review line, with the session id a reader drills into. Printing it here is what lets a diagnosis point `session_trace` at the session the review came from without a second lookup (§2.7.5). */
function renderReview(review: ReviewRecord): string[] {
  const duration = review.durationMs === undefined ? '' : ` duration ${review.durationMs}ms`
  const session = review.sessionId === undefined ? '' : ` session ${review.sessionId}`
  const lines = [`- review ${reviewRef(review)} [${review.outcome}]${duration} evidence: [${review.evidenceRefs.join(', ')}]${session}`]
  if (review.relatedTaskIds !== undefined) lines.push(`  relatedTaskIds: [${review.relatedTaskIds.join(', ')}]`)
  if (review.localizedCause !== undefined) lines.push(`  cause: ${review.localizedCause}`)
  for (const anomaly of review.anomalies) lines.push(`  anomaly: ${anomaly}`)
  for (const criterion of review.criteria ?? []) {
    // The deciding judge rides next to the verdict (S1-V slice 2): a reader of
    // the pack sees which registered verifier decided, at which version, without
    const judge = criterion.verifierId === undefined
      ? ''
      : criterion.verifierVersion === undefined
        ? ` [${criterion.verifierId}]`
        : ` [${criterion.verifierId}@${criterion.verifierVersion}]`
    const command = criterion.command === undefined ? '' : ` — $ ${criterion.command}`
    const exit = criterion.exitCode === undefined ? '' : ` exit ${criterion.exitCode}`
    const log = criterion.logRef === undefined ? '' : ` log ${criterion.logRef}`
    const unknown = criterion.unknownKind === undefined ? '' : ` unknownKind ${criterion.unknownKind}`
    lines.push(`  criterion ${criterion.criterionId}: ${criterion.verdict}${judge}${exit}${command}${log}${unknown}`)
  }
  for (const blocker of review.blockedBy ?? []) lines.push(`  blockedBy ${blocker.taskId} [${blocker.outcome}]`)
  if (review.metrics !== undefined) {
    const metrics = renderMetrics(review.metrics)
    if (metrics.length > 0) lines.push(`  metrics: ${metrics}`)
  }
  if (review.dimensions !== undefined) lines.push(...renderDimensions(review.dimensions))
  if (review.logTail !== undefined) lines.push('  logTail:', ...review.logTail.split('\n').map(line => `    ${line}`))
  return lines
}

/** How far one diagnosis's hand-off has gone (A5 §3, plan F.4): what the ledger, the allowance and the source's rounds answer for it. */
function handoffMark(diagnosis: Diagnosis, handoff: HandoffFacts, snapshot: TaskSnapshot): string {
  if (!needsSupervisor(snapshot, diagnosis, handoff.attempts)) return 'coordinator-owned — delivered to the existing coordinator; no shared improvement requires a supervisor'
  return handoffStateLine({
    diagnosis,
    attempts: handoff.attempts,
    budget: handoff.budget,
    rounds: roundsForDiagnosis(snapshot, diagnosis),
  })
}

function renderDiagnosis(diagnosis: Diagnosis, handoff: HandoffFacts, snapshot: TaskSnapshot): string[] {
  const producer = diagnosis.producedBy === undefined
    ? ''
    : diagnosis.producedBy.kind === 'agent' && diagnosis.producedBy.sessionId !== undefined
      ? ` [agent ${diagnosis.producedBy.sessionId}]`
      : ` [${diagnosis.producedBy.kind}]`
  const lines = [`- ${diagnosis.diagnosisId} [${diagnosis.confidence}] ${diagnosis.localizedCause}${producer}`]
  lines.push(
    `  observation: ${diagnosis.observedFailure}`,
    `  scope: ${diagnosis.scope}; task ${diagnosis.taskId}`,
    `  reviewRefs: [${diagnosis.reviewRefs.join(', ')}]; evidenceRefs: [${diagnosis.evidenceRefs.join(', ')}]; relatedTaskIds: [${(diagnosis.relatedTaskIds ?? []).join(', ')}]`,
  )
  if (diagnosis.judgements !== undefined && diagnosis.judgements.length > 0) {
    const header = diagnosis.producedBy?.kind === 'agent' && diagnosis.producedBy.sessionId !== undefined
      ? `judgements (agent ${diagnosis.producedBy.sessionId})`
      : 'judgements'
    lines.push(`  ${header}:`)
    for (const judgement of diagnosis.judgements) {
      lines.push(`    ${judgement.dimension}: ${judgement.verdict} — ${judgement.rationale} refs [${judgement.evidenceRefs.join(', ')}]`)
    }
  }
  for (const proposal of diagnosis.proposals) lines.push(`  proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`)
  lines.push(`  handoff: ${handoffMark(diagnosis, handoff, snapshot)}`)
  return lines
}

/** What the exact source run was bound to and loaded (S1-C item 4). */
function renderBindings(snapshot: TaskSnapshot, source: ReviewAgentSource): string[] {
  const lines: string[] = []
  for (const run of snapshot.runs.filter(item => item.taskId === source.taskId && item.runId === source.runId)) {
    const binding = run.providerBinding
    if (binding === undefined) continue
    const skills = binding.skills.length === 0
      ? 'no provider skill'
      : binding.skills
        .map(skill => `${skill.name} [${skill.role}] content ${skill.contentDigest.slice(0, 12)}${skill.contractDigest === null ? '' : ` contract ${skill.contractDigest.slice(0, 12)}`}`)
        .join('; ')
    const servers = binding.mcpServers.length === 0
      ? ''
      : `; mcp ${binding.mcpServers.map(server => server.serverName).join(', ')}`
    const snapshotRoot = binding.snapshotRoot === undefined ? '' : `; snapshot ${binding.snapshotRoot}`
    lines.push(`- run ${run.runId} [${run.status}] bound registry ${binding.registryRevision.slice(0, 12)}: ${skills}${servers}${snapshotRoot}`)
  }
  return lines
}

/** Everything one pack renders from, all read by its caller for one exact source. */
export interface ReviewPackInput {
  readonly snapshot: TaskSnapshot
  /** The review source the pack is for: the task and its run, or the no-run case. */
  readonly source: ReviewAgentSource
  /** The store's coordination attempts, as the ledger holds them (`readReviewAgentAttempts`). */
  readonly attempts: readonly ReviewAgentAttempt[]
  /** What this deployment would do with each diagnosis's hand-off (A6). */
  readonly handoff: HandoffFacts
}

/** One exact source in full, with bounded same-graph evidence navigation through the existing read tools. */
export function buildReviewPack(input: ReviewPackInput): string {
  const { snapshot, source, attempts, handoff } = input
  const { taskId } = source
  const task = snapshot.tasks.find(item => item.taskId === taskId)
  if (task === undefined) throw new Error(`task_review_pack: unknown task "${taskId}"`)
  const review = reviewForSource(snapshot, source)
  const reviews = snapshot.reviews.filter(item => item.taskId === task.taskId)
  const incoming = snapshot.edges.filter(edge => edge.to === task.taskId).map(edge => edge.from)
  const outgoing = snapshot.edges.filter(edge => edge.from === task.taskId).map(edge => edge.to)
  const diagnoses = snapshot.diagnoses.filter(item => item.taskId === task.taskId ||
    item.reviewRefs.includes(reviewRef(source)) || item.relatedTaskIds?.includes(task.taskId))
  const sourceRun = source.runId === null ? undefined : snapshot.runs.find(run => run.runId === source.runId && run.taskId === taskId)
  const latestRunId = task.runIds.at(-1)
  const lines = [
    `review pack for task ${task.taskId} [${task.status}] depth ${task.depth}`,
    `source: review ${reviewRef(source)}${review === undefined ? ' (not on the record)' : ` [${review.outcome}]`}`,
    `source run: ${sourceRun === undefined ? 'none' : `${sourceRun.runId} [${sourceRun.status}] session ${sourceRun.sessionId ?? review?.sessionId ?? 'unknown'}; ${sourceRun.runId === latestRunId ? 'latest run' : 'historical run'}; preset ${sourceRun.agentPreset ?? 'unknown'}`}; latest run of task: ${latestRunId ?? 'none'}`,
    `objective: ${task.objective}`,
    `dependencies: must verify first [${incoming.join(', ')}]; blocks [${outgoing.join(', ')}]`,
    ...renderAttempts(attempts, source),
    renderJudgementDimensions(),
    `reviews (${reviews.length}): exact source in full; other versions in graph navigation`,
    ...(review === undefined ? [] : renderReview(review)),
    ...renderBindings(snapshot, source),
  ]
  const navigation = [
    'Navigation: task_status scope:"graph" pages tasks; context_read kind:"task"/"run"/"evidence"/"diagnosis" ref:<id> reads exact records; kind:"review" ref:{taskId,runId} reads one exact review; kind:"session" ref:<sessionId> reads session events in pages.',
    'Counters are recorded observations, sometimes session-cumulative; missing fields are unobserved. Complete cost: unknown — worker counters alone do not account for reviewer, supervisor and replay spend. No graph total is inferred.',
  ]
  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const footerReserve = 512
  const navigationBytes = navigation.reduce((total, line) => total + utf8Bytes(line) + 1, 0)
  if (utf8Bytes(lines.join('\n')) + navigationBytes + footerReserve > budget.maxBytes) {
    return `task_review_pack: exact source ${reviewRef(source)} exceeds the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound; its full record was not shortened. Read it in pages with context_read kind:"review" ref:${JSON.stringify({ taskId, runId: source.runId })}${source.runId === null ? '' : `, and kind:"run" ref:${JSON.stringify(source.runId)}`}; task_status scope:"graph" navigates this graph.`
  }
  budget.addAll(lines)
  budget.addAll(navigation)
  const tasks = [...snapshot.tasks].sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0)
  const shownTasks = budgetList(budget, {
    header: [`graph DAG navigation (${tasks.length} tasks; current task state, exact run history; short digests, full identities through context_read):`],
    units: tasks.slice(0, 20),
    reserve: footerReserve,
    lines: entry => {
      const incoming = snapshot.edges.filter(edge => edge.to === entry.taskId).map(edge => edge.from)
      const outgoing = snapshot.edges.filter(edge => edge.from === entry.taskId).map(edge => edge.to)
      const template = entry.templateRef === undefined ? 'unknown'
        : `${entry.templateRef.id}@${entry.templateRef.version} digest ${entry.templateRef.digest.slice(0, 12)}`
      const definition = entry.definitionRef === undefined ? 'unknown' : `${entry.definitionRef.taskType}@${entry.definitionRef.version}`
      const diagnosisRefs = snapshot.diagnoses.filter(item => item.taskId === entry.taskId || item.relatedTaskIds?.includes(entry.taskId)).map(item => item.diagnosisId)
      const lines = [`- task ${entry.taskId} [${entry.status}] parent ${entry.parentTaskId ?? 'none'}; dependencies [${incoming.join(', ')}]; blocks [${outgoing.join(', ')}]; definition ${definition}; template ${template}; diagnoses [${diagnosisRefs.join(', ')}]`]
      for (const run of snapshot.runs.filter(item => item.taskId === entry.taskId)) {
        const review = reviewForSource(snapshot, { taskId: entry.taskId, runId: run.runId })
        const exact = run.taskId === source.taskId && run.runId === source.runId
        const latest = run.runId === entry.runIds.at(-1)
        const version = `${exact ? 'exact source, ' : ''}${latest ? 'latest run' : 'historical run'}`
        const binding = run.providerBinding
        const skills = binding === undefined ? 'unknown' : binding.skills.map(skill =>
          `${skill.name}[${skill.role}] content ${skill.contentDigest.slice(0, 12)} contract ${skill.contractDigest?.slice(0, 12) ?? 'unknown'}`).join('; ') || 'none'
        const frozen = latest || exact ? `; preset ${run.agentPreset ?? 'unknown'}; registry ${binding?.registryRevision.slice(0, 12) ?? 'unknown'}; frozen skills [${skills}]` : ''
        const metrics = review?.metrics === undefined ? '' : renderMetrics(review.metrics)
        lines.push(`  run ${run.runId} [${run.status}; ${version}] session ${run.sessionId ?? review?.sessionId ?? 'unknown'}; review ${review === undefined ? 'none' : `${reviewRef(review)} [${review.outcome}]`}${frozen}; observed counters ${metrics || 'unknown'}`)
      }
      for (const review of snapshot.reviews.filter(item => item.taskId === entry.taskId && item.runId === undefined)) {
        lines.push(`  review ${reviewRef(review)} [${review.outcome}; no-run source]`)
      }
      return lines
    },
    tail: count => [`navigation shown: ${count}/${tasks.length} tasks. Continue task_status scope:"graph" offset:${count}, then context_read for exact task, run, review and diagnosis refs; pages are separate observations.`],
  })
  if (shownTasks === undefined) budget.add('Graph navigation did not fit; use task_status scope:"graph" offset:0 and context_read for exact records.')
  const shownDiagnoses = budgetList(budget, {
    header: [`diagnoses (${diagnoses.length}):`],
    units: diagnoses,
    lines: diagnosis => renderDiagnosis(diagnosis, handoff, snapshot),
    tail: count => [`diagnoses shown: ${count}/${diagnoses.length}; exact records through context_read kind:"diagnosis" ref:<diagnosisId>, discovered through task_status scope:"graph".`],
  })
  if (shownDiagnoses === undefined) budget.add('Diagnoses did not fit; discover diagnosisRefs through task_status scope:"graph", then context_read kind:"diagnosis".')
  return budget.text()
}

export function defineTaskReviewPackTool(ctx: Context) {
  return defineTool({
    name: 'task_review_pack',
    description:
      'Read-only. Assemble the diagnosis input pack for ONE exact review source — a task and the run under review, ' +
      'or runId null for a review that carries no run (a task blocked before it started). The pack names the task ' +
      'itself, the exact source review in full (criteria, log tail, blockers, session), historical review references, the ' +
      'review attempts the ledger holds for this source and how each ended, the dimensions whose conclusion the ' +
      'fact table does not carry, the dependency edges touching ' +
      'it, and its diagnoses with any agent judgements — every diagnosis marked with its ' +
      'hand-off state (the supervisor it was delegated to, the outcome that settled it, or the named reason nothing ' +
      'was opened: no live root session, the source\'s round cap, or the allowance spent). It reports the facts only: whether a review agent runs is ' +
      'decided elsewhere (a terminal review is accepted on its own under the deployment\'s autoReview mode; an explicit call names its source). ' +
      'It adds bounded same-graph DAG navigation with exact run/session ids, template and frozen provider digests, and observed counters. Continue with task_status scope:"graph" and context_read; no ancestry or sibling log replay. Feed this to task_diagnose, or ' +
      'to task_review_agent when a judgement is needed.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task to assemble the pack for' },
      runId: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        required: true,
        description: 'The Run whose review the pack is for, exactly as its review record names it; null for a review with no run',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const graph = await ctx.graphs.graphForSession(sessionId(exec, 'task_review_pack'))
      const storeId = rootTaskStoreId(graph.rootSessionId)
      const source: ReviewAgentSource = { taskId: args.taskId, runId: args.runId }
      const snapshot = await ctx.task.openStore(storeId)
      if (!snapshot.tasks.some(task => task.taskId === args.taskId)) {
        throw new Error(`task_review_pack: unknown task "${args.taskId}" in store ${storeId}`)
      }
      if (args.runId !== null && !snapshot.runs.some(run => run.runId === args.runId && run.taskId === args.taskId)) {
        return `task_review_pack: run "${args.runId}" is not a run of task "${args.taskId}"; nothing to pack`
      }
      if (reviewForSource(snapshot, source) === undefined) {
        return `task_review_pack: no review record for source ${reviewRef(source)} in store ${storeId}; nothing to pack`
      }
      const attempts = await readReviewAgentAttempts(storeId)
      return buildReviewPack({
        snapshot,
        source,
        attempts,
        handoff: handoffFactsOf(attempts),
      })
    },
  })
}
