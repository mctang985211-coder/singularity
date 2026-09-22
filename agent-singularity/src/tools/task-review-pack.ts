import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type { Diagnosis, ReviewDimensions, ReviewMetrics, ReviewRecord, TaskId, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { countReviewAgentRuns, reviewAgentBudget } from '../review-agent-ledger.ts'
import { computeEscalation, renderEscalation, renderJudgementDimensions, type Escalation } from './review-escalation.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_review_pack: missing agent id')
  return id
}

/** The ref a diagnosis uses in `reviewRefs` to name one review record. */
export function reviewRef(review: ReviewRecord): string {
  return `${review.taskId}#${review.runId ?? 'no-run'}`
}

/** The task's most recent review, or nothing when it never settled one. */
export function latestReview(snapshot: TaskSnapshot, taskId: TaskId): ReviewRecord | undefined {
  return [...snapshot.reviews].reverse().find(item => item.taskId === taskId)
}

function reviewSummary(snapshot: TaskSnapshot, taskId: TaskId): string {
  const review = latestReview(snapshot, taskId)
  if (review === undefined) return 'no review'
  const detail = review.localizedCause ?? review.anomalies[0]
  return `review ${reviewRef(review)}: ${review.outcome}${detail === undefined ? '' : ` — ${detail}`}`
}

/**
 * The effort line: one clause per counter that exists, and nothing for the ones
 * that do not — an absent field means "not observed" (see `ReviewMetrics`), so
 * printing 0 for it would invent a measurement. The two counters whose scope is
 * easy to misread (`tokens`, `humanInterventions`) and the one that is
 * structurally constant (`retries`) carry their caveat inline.
 */
function renderMetrics(metrics: ReviewMetrics): string {
  const parts: string[] = []
  if (metrics.tokens !== undefined) {
    parts.push(`tokens in ${metrics.tokens.uncachedInputTokens}/out ${metrics.tokens.outputTokens}/cache ${metrics.tokens.cacheReadTokens}+${metrics.tokens.cacheWriteTokens} (session-cumulative)`)
  }
  if (metrics.toolCalls !== undefined) parts.push(`toolCalls ${metrics.toolCalls.calls} (${metrics.toolCalls.failures} failed)`)
  if (metrics.humanInterventions !== undefined) parts.push(`humanInterventions ${metrics.humanInterventions} (session-scoped)`)
  if (metrics.retries !== undefined) parts.push(`retries ${metrics.retries} (no retry branch exists yet; always 0)`)
  if (metrics.evidenceLogs !== undefined) parts.push(`evidenceLogs ${metrics.evidenceLogs}`)
  return parts.join(' — ')
}

/**
 * One line per dimension that the record actually carries: the observed facts,
 * copied out, never rated and never narrated. Anything a dimension omits is
 * omitted here too, so the pack stays a fact sheet — the explanation lives in
 * the diagnoses below it.
 */
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
    const loaded = skill.loaded === undefined || skill.loadedOutsideGrant === undefined
      ? ''
      : `, loaded [${skill.loaded.join(', ')}], outside grant [${skill.loadedOutsideGrant.join(', ')}]`
    lines.push(`  dim skill fit: granted [${skill.granted.join(', ')}]${loaded}`)
  }
  const tools = dimensions.toolFit
  if (tools !== undefined) {
    const called = tools.called === undefined || tools.calledOutsideGrant === undefined
      ? ''
      : `, called [${tools.called.map(item => `${item.name} x${item.count}`).join(', ')}], outside grant [${tools.calledOutsideGrant.join(', ')}]`
    lines.push(`  dim tool fit: granted [${tools.granted.join(', ')}]${called}`)
  }
  const context = dimensions.contextEfficiency
  if (context !== undefined) {
    const tokens = context.tokens === undefined
      ? ''
      : ` tokens in/out ${context.tokens.uncachedInputTokens}/${context.tokens.outputTokens}`
    const compactions = context.compactions === undefined ? '' : ` compactions ${context.compactions}`
    lines.push(`  dim context efficiency:${tokens}${compactions}`)
  }
  return lines
}

/**
 * One review line, with the session id a reader drills into. Printing it here
 * is what lets a diagnosis point `session_trace` at the session the review came
 * from without a second lookup (§2.7.5).
 */
function renderReview(review: ReviewRecord): string[] {
  const duration = review.durationMs === undefined ? '' : ` duration ${review.durationMs}ms`
  const session = review.sessionId === undefined ? '' : ` session ${review.sessionId}`
  const lines = [`- review ${reviewRef(review)} [${review.outcome}]${duration} evidence: [${review.evidenceRefs.join(', ')}]${session}`]
  if (review.localizedCause !== undefined) lines.push(`  cause: ${review.localizedCause}`)
  for (const anomaly of review.anomalies) lines.push(`  anomaly: ${anomaly}`)
  for (const criterion of review.criteria ?? []) {
    // The deciding judge rides next to the verdict (S1-V slice 2): a reader of
    // the pack sees which registered verifier decided, at which version, without
    // opening the evidence bundle. A record written before the judge was
    // recorded renders exactly as it did before — no suffix, nothing invented.
    const judge = criterion.verifierId === undefined
      ? ''
      : criterion.verifierVersion === undefined
        ? ` [${criterion.verifierId}]`
        : ` [${criterion.verifierId}@${criterion.verifierVersion}]`
    const command = criterion.command === undefined ? '' : ` — $ ${criterion.command}`
    const exit = criterion.exitCode === undefined ? '' : ` exit ${criterion.exitCode}`
    const log = criterion.logRef === undefined ? '' : ` log ${criterion.logRef}`
    lines.push(`  criterion ${criterion.criterionId}: ${criterion.verdict}${judge}${exit}${command}${log}`)
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

/**
 * One diagnosis, with its agent judgements kept visually apart from the
 * mechanical facts above: the facts say what was observed, a judgement says
 * what an agent concluded, and the header names the session so the two are
 * never read as one table.
 */
function renderDiagnosis(diagnosis: Diagnosis): string[] {
  const producer = diagnosis.producedBy === undefined
    ? ''
    : diagnosis.producedBy.kind === 'agent' && diagnosis.producedBy.sessionId !== undefined
      ? ` [agent ${diagnosis.producedBy.sessionId}]`
      : ` [${diagnosis.producedBy.kind}]`
  const lines = [`- ${diagnosis.diagnosisId} [${diagnosis.confidence}] ${diagnosis.localizedCause}${producer}`]
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
  return lines
}

/**
 * What each of the task's runs was bound to and loaded (S1-C item 4): one line
 * per run that recorded a binding, naming the registry revision, the providers
 * (skill, role, short content digest) and the granted MCP servers. This is what
 * makes "which version did this execution run against?" answerable from the
 * pack, next to the run ids the reviews above already cite.
 *
 * The pack reports the record; it does not re-read the snapshots. It is the
 * facts sheet a reviewer starts from, and the bytes are re-checked by the
 * entries that act on them (`task_read`, a run re-entry) — a line here says what
 * the run was bound to, never that the content is still on disk. A run that
 * carries no binding (one written before the field existed, or one whose caller
 * assembled its plan without a pre-check) contributes no line, and nothing is
 * invented for it.
 */
function renderBindings(snapshot: TaskSnapshot, taskId: TaskId): string[] {
  const lines: string[] = []
  for (const run of snapshot.runs.filter(item => item.taskId === taskId)) {
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

/**
 * The pack for one task: the facts first (reviews, dependency edges,
 * parent/child summaries), then the escalation decision, then the judgement
 * dimensions the facts cannot settle, then the diagnoses that explain them.
 * @throws when `taskId` is not in the snapshot.
 */
export function buildReviewPack(snapshot: TaskSnapshot, taskId: TaskId, escalation: Escalation): string {
  const task = snapshot.tasks.find(item => item.taskId === taskId)
  if (task === undefined) throw new Error(`task_review_pack: unknown task "${taskId}"`)
  const reviews = snapshot.reviews.filter(item => item.taskId === task.taskId)
  const parent = task.parentTaskId === undefined
    ? undefined
    : snapshot.tasks.find(item => item.taskId === task.parentTaskId)
  const incoming = snapshot.edges.filter(edge => edge.to === task.taskId).map(edge => edge.from)
  const outgoing = snapshot.edges.filter(edge => edge.from === task.taskId).map(edge => edge.to)
  const diagnoses = snapshot.diagnoses.filter(item => item.taskId === task.taskId)
  const lines = [
    `review pack for task ${task.taskId} [${task.status}] depth ${task.depth}`,
    `objective: ${task.objective}`,
    `dependencies: must verify first [${incoming.join(', ')}]; blocks [${outgoing.join(', ')}]`,
    renderEscalation(escalation),
    renderJudgementDimensions(),
    `reviews (${reviews.length}):`,
    ...reviews.flatMap(renderReview),
    ...renderBindings(snapshot, task.taskId),
  ]
  if (parent !== undefined) lines.push(`parent ${parent.taskId} [${parent.status}]: ${reviewSummary(snapshot, parent.taskId)}`)
  lines.push(`children (${task.childTaskIds.length}):`)
  for (const childId of task.childTaskIds) {
    const child = snapshot.tasks.find(item => item.taskId === childId)
    if (child === undefined) continue
    lines.push(`- ${child.taskId} [${child.status}]: ${reviewSummary(snapshot, child.taskId)}`)
  }
  lines.push(`diagnoses (${diagnoses.length}):`)
  for (const diagnosis of diagnoses) lines.push(...renderDiagnosis(diagnosis))
  return lines.join('\n')
}

export function defineTaskReviewPackTool(ctx: Context) {
  return defineTool({
    name: 'task_review_pack',
    description:
      'Read-only. Assemble the diagnosis input pack for one task: the task itself, all its review records in full ' +
      '(criteria, log tail, blockers, the session each review came from), the machine escalation decision, the six ' +
      'dimensions whose conclusion the fact table does not carry, one-line review summaries of its children and parent, ' +
      'the dependency edges touching it, and its diagnoses with any agent judgements. ' +
      'Local evidence plus parent/children summaries — no ancestry replay (guide §2.7.5). Feed this to task_diagnose, or ' +
      'to task_review_agent when escalation requires a judgement.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task to assemble the pack for' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const graph = await ctx.graphs.graphForSession(sessionId(exec))
      const storeId = rootTaskStoreId(graph.rootSessionId)
      const snapshot = await ctx.task.openStore(storeId)
      const used = await countReviewAgentRuns(storeId)
      const escalation = computeEscalation(snapshot, args.taskId, { used, max: reviewAgentBudget() })
      return buildReviewPack(snapshot, args.taskId, escalation)
    },
  })
}
